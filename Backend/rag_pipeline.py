import os
import re
import json
from dataclasses import dataclass, field, asdict
from typing import Any
from dotenv import load_dotenv
from exa_py import Exa
from sqlalchemy.orm import Session
from database import FAQRule, FailedRetrieval

from langchain_core.prompts import PromptTemplate
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_community.document_loaders import PyPDFLoader, TextLoader
from langchain_community.vectorstores import Chroma
from langchain_core.output_parsers import StrOutputParser
from langchain_openai import ChatOpenAI, OpenAIEmbeddings

# =========================================================
# LOAD ENV
# =========================================================

load_dotenv()
exa = Exa(api_key=os.environ.get("EXA_API_KEY"))

# =========================================================
# LANGSMITH CONFIG
# =========================================================

os.environ["LANGCHAIN_TRACING_V2"] = "true"
os.environ["LANGCHAIN_ENDPOINT"] = "https://api.smith.langchain.com"

# =========================================================
# CONFIG
# =========================================================

RELEVANCE_THRESHOLD = 0.15
RETRIEVAL_K = 6
MAX_HISTORY_TURNS = 6          # how many prior messages feed the rewriter
SNIPPET_CHARS = 320            # citation preview length

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
CHROMA_PERSIST_DIR = os.getenv("CHROMA_DB_PATH", "./chroma_db")

if not OPENROUTER_API_KEY:
    raise ValueError("OPENROUTER_API_KEY not found in .env file")

# =========================================================
# RESULT TYPES
# =========================================================

@dataclass
class Citation:
    """A single retrieved chunk, carried all the way to the UI."""
    index: int                      # 1-based marker shown in the answer
    document: str                   # display filename or web page title
    page: int | None = None         # PDF page (0-based from PyPDFLoader)
    snippet: str = ""
    score: float = 0.0              # relevance score for this chunk
    doc_id: int | None = None       # Document.id when known
    url: str | None = None          # set for web-fallback citations


@dataclass
class RagResult:
    answer: str
    citations: list[Citation] = field(default_factory=list)
    confidence: float = 0.0
    source_type: str = "none"       # documents|web|faq|none
    retrieval_failed: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "answer": self.answer,
            "citations": [asdict(c) for c in self.citations],
            "confidence": round(self.confidence, 3),
            "source_type": self.source_type,
        }


# =========================================================
# INDEXING & STORAGE
# =========================================================

embedding_func = OpenAIEmbeddings(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
    model="openai/text-embedding-ada-002",
)

vectorstore = Chroma(
    persist_directory=CHROMA_PERSIST_DIR,
    embedding_function=embedding_func
)

text_splitter = RecursiveCharacterTextSplitter(
    chunk_size=1000,
    chunk_overlap=200,
)


def ingest_document(file_path: str, doc_id: int | None = None) -> int:
    """Load a file, split it, and add it to the vectorstore.

    Each chunk carries `doc_id` and `filename` metadata so answers can cite the
    originating document and so deletion can target a document precisely.

    Returns the number of chunks indexed.
    """
    from settings_manager import load_settings
    settings = load_settings()
    local_text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=settings.get("chunk_size", 1000),
        chunk_overlap=settings.get("chunk_overlap", 200),
    )

    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".pdf":
        loader = PyPDFLoader(file_path)
    elif ext == ".txt":
        loader = TextLoader(file_path, encoding="utf-8")
    elif ext == ".docx":
        from langchain_community.document_loaders import Docx2txtLoader
        loader = Docx2txtLoader(file_path)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    docs = loader.load()
    splits = text_splitter.split_documents(docs)

    filename = os.path.basename(file_path)
    for i, chunk in enumerate(splits):
        chunk.metadata["filename"] = filename
        chunk.metadata["chunk_index"] = i
        if doc_id is not None:
            chunk.metadata["doc_id"] = doc_id

    if splits:
        vectorstore.add_documents(documents=splits)

    return len(splits)


def delete_document_chunks(file_path: str, doc_id: int | None = None) -> int:
    """Remove every chunk belonging to a document. Matches on doc_id when
    available and falls back to the legacy `source` path filter."""
    ids: list[str] = []

    if doc_id is not None:
        ids = vectorstore.get(where={"doc_id": doc_id}).get("ids", [])

    if not ids:
        ids = vectorstore.get(where={"source": file_path}).get("ids", [])

    if ids:
        vectorstore.delete(ids=ids)

    return len(ids)


# =========================================================
# RETRIEVAL
# =========================================================

def retrieve_context(question: str) -> tuple[str, list[Citation], float]:
    """Retrieve relevant chunks, preserving the metadata needed for citations.

    Returns (context_block, citations, highest_score). The context block is
    numbered so the model can reference sources as [1], [2], ...
    """
    results = vectorstore.similarity_search_with_relevance_scores(question, k=RETRIEVAL_K)

    highest_score = results[0][1] if results else 0.0

    relevant = [(doc, score) for doc, score in results if score >= RELEVANCE_THRESHOLD]
    if not relevant:
        return "", [], highest_score

    citations: list[Citation] = []
    blocks: list[str] = []

    for i, (doc, score) in enumerate(relevant, start=1):
        meta = doc.metadata or {}
        name = meta.get("filename") or os.path.basename(str(meta.get("source", "Unknown document")))
        page = meta.get("page")
        snippet = " ".join(doc.page_content.split())[:SNIPPET_CHARS]

        citations.append(Citation(
            index=i,
            document=name,
            page=int(page) if isinstance(page, (int, float)) else None,
            snippet=snippet,
            score=round(float(score), 3),
            doc_id=meta.get("doc_id"),
        ))

        header = f"[{i}] {name}"
        if page is not None:
            header += f" (page {int(page) + 1})"
        blocks.append(f"{header}\n{doc.page_content}")

    return "\n\n".join(blocks), citations, highest_score


def _confidence_from(highest_score: float, citations: list[Citation]) -> float:
    """Blend best-match strength with corroboration across chunks.

    A single weak hit should not read as confident, and several agreeing chunks
    should read as more confident than one.
    """
    if not citations:
        return 0.0
    top = max(0.0, min(1.0, highest_score))
    corroboration = min(len(citations), 3) / 3.0
    return round(0.75 * top + 0.25 * top * corroboration, 3)


# =========================================================
# PROMPTS
# =========================================================

prompt = PromptTemplate(
    input_variables=["context", "question", "history"],
    template="""
You are Valar, a knowledgeable, concise, and professional Enterprise Support Copilot.

You can:
- Answer support, service procedure, troubleshooting, maintenance and company policy questions.
- Guide technicians and engineers using official documentation, manuals, resolution guides and FAQ material.

Rules:
1. If the question is a greeting, or about your identity, capabilities, or what you can help with,
   answer directly in a friendly manner without using the context.
2. For all support-related queries, answer ONLY using the provided context.
3. CRITICAL RULE: If the exact answer or specific details relevant to the query are NOT present in the Context block below, you MUST respond exactly with the phrase: "Sorry, I don't know based on the given context." Do not provide any other information or guesses. Do not provide a partial answer.
4. CITATIONS: Every factual sentence drawn from the context MUST end with the bracketed
   marker of the source it came from, e.g. [1] or [2]. Use the numbers exactly as they
   appear in the Context block. Never invent a citation number that is not in the context.
5. Keep answers clear, simple, and professional.
6. Provide troubleshooting steps in bullet points when applicable.
7. Do NOT add assumptions or external information.

Conversation so far (for pronoun and follow-up resolution only — never cite it as a source):
{history}

Context:
{context}

User Question:
{question}

Answer:
"""
)

rewrite_prompt = PromptTemplate(
    input_variables=["history", "question"],
    template="""
Rewrite the user's latest question into a standalone search query that makes sense
without the conversation history. Resolve pronouns and implicit references
("it", "that pump", "the same procedure") using the history.

Return ONLY the rewritten query, with no preamble or quotes.
If the question is already standalone, return it unchanged.

Conversation history:
{history}

Latest question: {question}

Standalone query:"""
)

# =========================================================
# LLM
# =========================================================

llm = ChatOpenAI(
    api_key=OPENROUTER_API_KEY,
    base_url="https://openrouter.ai/api/v1",
    model="openai/gpt-oss-120b",
    max_tokens=1000
)

# =========================================================
# CONVERSATION MEMORY
# =========================================================

def format_history(history: list[dict[str, str]] | None) -> str:
    """Render prior turns for the prompt. `history` is a list of
    {"role": "user"|"assistant", "content": str}, oldest first."""
    if not history:
        return "(no previous messages)"

    recent = history[-MAX_HISTORY_TURNS:]
    lines = []
    for turn in recent:
        role = "User" if turn.get("role") == "user" else "Valar"
        content = " ".join(str(turn.get("content", "")).split())
        if len(content) > 500:
            content = content[:500] + "…"
        lines.append(f"{role}: {content}")
    return "\n".join(lines)


def rewrite_query(question: str, history: list[dict[str, str]] | None) -> str:
    """Resolve follow-ups into standalone queries before retrieval.

    Without this, "what about the other pump?" retrieves on those five words
    alone and finds nothing.
    """
    if not history:
        return question

    try:
        chain = rewrite_prompt | llm | StrOutputParser()
        rewritten = chain.invoke({
            "history": format_history(history),
            "question": question,
        }).strip()

        # Guard against the model returning an explanation or empty string
        if not rewritten or len(rewritten) > 400:
            return question
        return rewritten
    except Exception as e:
        print(f"[rewrite] falling back to raw question: {e}")
        return question


# =========================================================
# SECONDARY RAG / FALLBACK
# =========================================================

def is_support_relevant(question: str) -> bool:
    relevance_prompt = PromptTemplate(
        input_variables=["question"],
        template="""
Determine if the following question is related to technical support, IT help, troubleshooting, operations, equipment, safety, compliance, or general workplace queries.
Respond with exactly YES or NO.

Question: {question}
"""
    )
    chain = relevance_prompt | llm | StrOutputParser()
    try:
        result = chain.invoke({"question": question})
        return "YES" in result.strip().upper()
    except Exception:
        return False


def exa_search_fallback(question: str) -> tuple[str, list[Citation]]:
    """Answer from the open web. Returns (answer, citations) so the caller can
    label the result as ungrounded rather than passing it off as plant
    documentation.

    Raises on API failure so the caller can fall back to an honest "I don't
    know" instead of labelling an error string as a web-sourced answer.
    """
    response = exa.answer(question)
    answer_text = response.answer

    links = re.findall(r'\[([^\]]+)\]\((https?://[^\)]+)\)', answer_text)

    citations: list[Citation] = []
    seen_urls: set[str] = set()
    for title, url in links:
        if url not in seen_urls:
            seen_urls.add(url)
            citations.append(Citation(
                index=len(citations) + 1,
                document=title,
                snippet="",
                score=0.0,
                url=url,
            ))

    # Strip Exa's inline citation blocks — we render citations ourselves.
    answer_text = re.sub(r'\s*\((?:\[[^\]]+\]\((?:https?://[^\)]+)\)(?:,\s*)?)+\)', '', answer_text)
    answer_text = re.sub(r'\[([^\]]+)\]\((https?://[^\)]+)\)', r'\1', answer_text)

    return clean_answer(answer_text), citations


# =========================================================
# RAG FUNCTION
# =========================================================

_FALLBACK_TRIGGERS = [
    "don't know based on the given context",
    "don’t know based on the given context",
    "do not know based on the given context",
    "don't know based on the context",
    "don’t know based on the context",
    "don't know",  # catch shorter versions of the LLM defying prompt rules
]


_MOJIBAKE_MARKERS = ("â€", "Ã", "Â", "â€™", "â€œ")


def _repair_mojibake(text: str) -> str:
    """Undo UTF-8 bytes that were decoded as cp1252 ("Pâ€'101A" -> "P‑101A").

    Repairs run by run so characters outside cp1252 (emoji, CJK) survive, and
    only when the round-trip decodes cleanly — genuine accented text fails that
    check and is left untouched.
    """
    if not text or not any(m in text for m in _MOJIBAKE_MARKERS):
        return text

    out: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        if not buf:
            return
        chunk = "".join(buf)
        try:
            out.append(chunk.encode("cp1252").decode("utf-8"))
        except (UnicodeEncodeError, UnicodeDecodeError):
            out.append(chunk)
        buf.clear()

    for ch in text:
        try:
            ch.encode("cp1252")
        except UnicodeEncodeError:
            flush()
            out.append(ch)
        else:
            buf.append(ch)
    flush()

    return "".join(out)


def _normalize_citation_markers(text: str) -> str:
    """Models emit 【1】, [ 1 ] and [1] interchangeably. Normalise to [1] so the
    markers render correctly and can actually be parsed."""
    return re.sub(r'[\[【〔]\s*(\d{1,2})\s*[\]】〕]', r'[\1]', text)


def clean_answer(text: str) -> str:
    # Order matters: normalising brackets first removes non-cp1252 characters
    # that would otherwise block the mojibake repair.
    return _repair_mojibake(_normalize_citation_markers(text)).strip()


def _cited_indices(answer: str) -> set[int]:
    return {int(n) for n in re.findall(r'\[(\d{1,2})\]', answer)}


def rag_answer(
    question: str,
    db: Session = None,
    history: list[dict[str, str]] | None = None,
) -> RagResult:
    """Answer a question against the indexed corpus.

    Returns a RagResult carrying the answer plus the citations and confidence
    the UI needs. Callers that only want text can use `.answer`.
    """
    # 1. FAQ check — a curated answer always wins
    if db is not None:
        try:
            active_rules = db.query(FAQRule).filter(FAQRule.is_active == True).all()  # noqa: E712
            q_lower = question.lower()
            matches = [r for r in active_rules if r.keyword.lower() in q_lower]
            if matches:
                best_match = max(matches, key=lambda r: len(r.keyword))
                return RagResult(
                    answer=best_match.response,
                    citations=[],
                    confidence=1.0,
                    source_type="faq",
                )
        except Exception as e:
            print(f"Error matching FAQ rules: {e}")

    # 2. Resolve follow-ups, then retrieve
    search_query = rewrite_query(question, history)
    context, citations, highest_score = retrieve_context(search_query)
    retrieval_failed = (not context or highest_score < RELEVANCE_THRESHOLD)

    chain = prompt | llm | StrOutputParser()
    answer = clean_answer(chain.invoke({
        "context": context or "(no documents matched this query)",
        "question": question,
        "history": format_history(history),
    }))

    answer_lower = answer.lower()
    refused = any(trigger in answer_lower for trigger in _FALLBACK_TRIGGERS)
    if refused:
        retrieval_failed = True

    source_type = "documents"
    confidence = _confidence_from(highest_score, citations)

    # 3. Web fallback — clearly labelled, never blended with document answers
    if refused:
        citations = []
        confidence = 0.0
        source_type = "none"

        if is_support_relevant(question):
            extended_query = f"{search_query} technical support troubleshooting manual"
            try:
                web_answer, web_citations = exa_search_fallback(extended_query)
                answer = web_answer
                citations = web_citations
                source_type = "web"
                confidence = 0.35 if web_citations else 0.2
            except Exception as e:
                # Keep the honest refusal rather than presenting an API error
                # under a "answered from the web" banner.
                print(f"Exa search fallback failed: {e}")
                answer = (
                    "I couldn't find anything about this in your indexed documents, "
                    "and the web search fallback is currently unavailable. "
                    "Try rephrasing, or ask an administrator to upload the relevant document."
                )
    else:
        # Drop citations the model never referenced so the UI doesn't show
        # sources that had no bearing on the answer.
        used = _cited_indices(answer)
        if used:
            citations = [c for c in citations if c.index in used]

    # 4. Log the gap for the knowledge-gap dashboard
    if retrieval_failed and db is not None:
        try:
            db.add(FailedRetrieval(
                query_text=question,
                highest_score=highest_score,
                fallback_triggered=(source_type == "web"),
            ))
            db.commit()
        except Exception as e:
            db.rollback()
            print(f"Failed to log retrieval analytics: {e}")

    return RagResult(
        answer=answer,
        citations=citations,
        confidence=confidence,
        source_type=source_type,
        retrieval_failed=retrieval_failed,
    )


def serialize_citations(citations: list[Citation]) -> str:
    return json.dumps([asdict(c) for c in citations])


# =========================================================
# FOLLOW-UP SUGGESTIONS
# =========================================================

follow_up_prompt = PromptTemplate(
    input_variables=["question", "answer", "sources"],
    template="""
You suggest follow-up questions for a technician using an industrial support copilot.

Given the question just asked, the answer given, and excerpts from the source
documents, propose up to 3 short follow-up questions the user is likely to ask next.

Rules:
- Each question must be answerable from the same document material shown below.
  Do not invent topics the sources say nothing about.
- Keep each under 60 characters. Write them as the user would type them.
- Make them specific: prefer "What is the vibration limit for P-101A?" over
  "Tell me more about this".
- Do not repeat the question that was already asked.
- Output ONE question per line, with no numbering, bullets or quotes.
- If no useful follow-up exists (for example the answer was a greeting, an error,
  or the sources are empty), output exactly: NONE

Question asked: {question}

Answer given: {answer}

Source excerpts:
{sources}

Follow-up questions:"""
)


def generate_follow_ups(
    question: str,
    answer: str,
    citations: list[Citation] | list[dict] | None = None,
) -> list[str]:
    """Propose follow-up questions grounded in the same sources as the answer.

    Returns [] when nothing sensible can be suggested — the caller should then
    render no chips rather than falling back to canned text.
    """
    snippets: list[str] = []
    for c in (citations or []):
        text = c.get("snippet") if isinstance(c, dict) else c.snippet
        name = c.get("document") if isinstance(c, dict) else c.document
        if text:
            snippets.append(f"- ({name}) {text}")

    if not snippets:
        return []

    try:
        chain = follow_up_prompt | llm | StrOutputParser()
        raw = chain.invoke({
            "question": question,
            "answer": answer[:1500],
            "sources": "\n".join(snippets[:6]),
        })
    except Exception as e:
        print(f"[follow-ups] generation failed: {e}")
        return []

    raw = clean_answer(raw)
    if "NONE" in raw.upper()[:20]:
        return []

    suggestions: list[str] = []
    for line in raw.splitlines():
        # Strip bullets, numbering and stray quotes the model may add anyway
        line = re.sub(r'^\s*(?:[-*•]|\d+[.)])\s*', '', line).strip().strip('"\'')
        if not line or len(line) > 120:
            continue
        if line.lower() == question.lower().strip():
            continue
        suggestions.append(line)
        if len(suggestions) == 3:
            break

    return suggestions

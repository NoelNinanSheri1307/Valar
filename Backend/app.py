import os
import shutil
import logging
import json
from typing import Annotated
from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func
from pydantic import BaseModel

from database import engine, Base, get_db, User, ChatSession, ChatMessage, FAQRule, FailedRetrieval
from datetime import datetime
from auth import (
    get_password_hash,
    verify_password,
    create_access_token,
    get_current_user,
    get_current_admin_user,
    ACCESS_TOKEN_EXPIRE_MINUTES,
    timedelta
)
from rag_pipeline import rag_answer, ingest_document
from activity_logger import log_activity, get_activity_logs
from settings_manager import load_settings, save_settings, DEFAULT_SETTINGS

# Create Tables
Base.metadata.create_all(bind=engine)

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(
    title="Valar - Support Agent Copilot API",
    description="Backend RAG API for Valar Customer Support Copilot",
    version="2.0.0",
)

# Configure production-safe CORS
allowed_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]
env_origins = os.getenv("ALLOWED_ORIGINS")
if env_origins:
    allowed_origins.extend([o.strip() for o in env_origins.split(",") if o.strip()])

frontend_url = os.getenv("FRONTEND_URL")
if frontend_url:
    allowed_origins.append(frontend_url.strip())

# Clean up origins to prevent trailing slash mismatches
allowed_origins = list(set(o.rstrip('/') for o in allowed_origins))

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_validation():
    # 1. Database folder checks
    db_path = os.getenv("DATABASE_PATH", "./users.db")
    db_dir = os.path.dirname(db_path)
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)
    
    # 2. Chroma folder checks
    chroma_path = os.getenv("CHROMA_DB_PATH", "./chroma_db")
    if not os.path.exists(chroma_path):
        os.makedirs(chroma_path, exist_ok=True)
        
    # 3. Upload folder checks
    upload_dir = os.getenv("UPLOAD_DIRECTORY", "uploaded_files")
    if not os.path.exists(upload_dir):
        os.makedirs(upload_dir, exist_ok=True)
        
    # 4. Settings file checks
    from settings_manager import SETTINGS_FILE, DEFAULT_SETTINGS, save_settings
    if not os.path.exists(SETTINGS_FILE):
        save_settings(DEFAULT_SETTINGS)
        
    # 5. Activity log checks
    from activity_logger import LOG_FILE
    if not os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE, "w", encoding="utf-8") as f:
                json.dump([], f)
        except Exception as e:
            print(f"Error initializing activity logs file: {e}")

# -------------------------
# Schemas
# -------------------------

class UserCreate(BaseModel):
    username: str
    password: str
    role: str = "technician"  # default to technician

class Token(BaseModel):
    access_token: str
    token_type: str

class QueryRequest(BaseModel):
    question: str

class ChatMessageResponse(BaseModel):
    id: int
    role: str
    content: str
    created_at: datetime
    
    model_config = {"from_attributes": True}

class ChatSessionResponse(BaseModel):
    id: int
    title: str
    created_at: datetime
    
    model_config = {"from_attributes": True}

class FAQRuleCreate(BaseModel):
    keyword: str
    response: str
    is_active: bool = True

class FAQRuleResponse(BaseModel):
    id: int
    keyword: str
    response: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}

class GapQueryAnalyticsResponse(BaseModel):
    query_text: str
    failure_count: int
    highest_score: float
    created_at: str

class AnalyticsGapsResponse(BaseModel):
    failed_rate: str
    total_failed: int
    gaps: list[GapQueryAnalyticsResponse]

# -------------------------
# Auth Endpoints
# -------------------------

@app.post("/register", status_code=status.HTTP_201_CREATED)
def register(user: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username already registered")
    
    hashed_password = get_password_hash(user.password)
    new_user = User(
        username=user.username,
        hashed_password=hashed_password,
        role="technician"  # Force technician role regardless of input
    )
    db.add(new_user)
    db.commit()
    return {"message": "User created successfully"}

@app.post("/register_admin", status_code=status.HTTP_201_CREATED)
def register_admin(user: UserCreate, db: Session = Depends(get_db)):
    db_user = db.query(User).filter(User.username == user.username).first()
    if db_user:
        raise HTTPException(status_code=400, detail="Username already registered")
    
    hashed_password = get_password_hash(user.password)
    new_user = User(
        username=user.username,
        hashed_password=hashed_password,
        role="manager"  # Force manager role
    )
    db.add(new_user)
    db.commit()
    return {"message": "Admin user created successfully"}

@app.post("/token", response_model=Token)
def login_for_access_token(
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
    db: Session = Depends(get_db)
):
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = create_access_token(
        data={"sub": user.username, "role": user.role},
        expires_delta=access_token_expires
    )
    log_activity(user.username, "Login")
    return {"access_token": access_token, "token_type": "bearer"}

@app.get("/users/me")
def read_users_me(current_user: User = Depends(get_current_user)):
    return {
        "username": current_user.username,
        "role": current_user.role
    }

# -------------------------
# File Upload (Admin Only)
# -------------------------

UPLOAD_DIR = os.getenv("UPLOAD_DIRECTORY", "uploaded_files")
os.makedirs(UPLOAD_DIR, exist_ok=True)

# File types the pipeline can actually ingest
ALLOWED_EXTENSIONS = {".pdf", ".txt", ".docx"}

@app.post("/upload")
def upload_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_admin_user)
):
    ext = os.path.splitext(file.filename or "")[1].lower()
    if ext == ".doc":
        raise HTTPException(
            status_code=400,
            detail="Legacy .doc format requires system-level dependencies (antiword/LibreOffice) to parse. Please convert the file to .docx or .pdf before uploading."
        )
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: PDF, TXT, DOCX."
        )

    file_location = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_location, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    # Ingest into RAG
    try:
        ingest_document(file_location)
    except Exception as e:
        os.remove(file_location)  # clean up orphan file
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")

    log_activity(current_user.username, "Upload", file.filename)
    return {"filename": file.filename, "status": "Uploaded and Indexed"}

@app.get("/files")
def list_files(current_user: User = Depends(get_current_admin_user)):
    try:
        files = []
        if os.path.exists(UPLOAD_DIR):
            for filename in os.listdir(UPLOAD_DIR):
                filepath = os.path.join(UPLOAD_DIR, filename)
                if os.path.isfile(filepath):
                    files.append({
                        "filename": filename,
                        "size": os.path.getsize(filepath),
                        "uploaded_at": datetime.fromtimestamp(os.path.getmtime(filepath)).isoformat()
                    })
        return files
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to list files: {str(e)}")

@app.delete("/files/{filename}", status_code=status.HTTP_200_OK)
def delete_file(
    filename: str,
    current_user: User = Depends(get_current_admin_user)
):
    """Delete an uploaded document: removes the file from disk and purges its
    embeddings from ChromaDB using the LangChain source metadata key."""
    file_location = os.path.join(UPLOAD_DIR, filename)

    if not os.path.exists(file_location):
        raise HTTPException(status_code=404, detail=f"File '{filename}' not found.")

    print("\n[Delete]")
    print(f"Document: {filename}")
    print(f"Metadata used during deletion: {{'source': '{file_location}'}}")

    # 1. Remove embeddings from ChromaDB
    try:
        from rag_pipeline import vectorstore
        existing = vectorstore.get(where={"source": file_location})
        ids_to_delete = existing.get("ids", [])
        num_embeddings = len(ids_to_delete)
        print(f"Found {num_embeddings} embeddings")
        
        if num_embeddings > 0:
            vectorstore.delete(ids=ids_to_delete)
            print(f"Deleted {num_embeddings} embeddings")
            print("Deleted metadata")
            
        # Verify deletion
        verify_existing = vectorstore.get(where={"source": file_location})
        num_remaining = len(verify_existing.get("ids", []))
        print(f"Number remaining: {num_remaining}")
        
        if num_remaining > 0:
            raise Exception("ChromaDB still contains embeddings for this document after deletion.")
            
    except Exception as e:
        logger.error("[Delete] Failed to purge embeddings: %s", e)
        raise HTTPException(status_code=500, detail=f"Failed to remove vector embeddings: {str(e)}")

    # 2. Delete physical file
    try:
        os.remove(file_location)
        print("Deleted file")
        print("Delete completed successfully")
    except Exception as e:
        logger.error("[Delete] Failed to remove file from disk: %s", e)
        raise HTTPException(status_code=500, detail=f"Could not delete file from disk: {str(e)}")

    log_activity(current_user.username, "Delete", filename)
    return {
        "filename": filename,
        "status": "deleted"
    }

# -------------------------
# Re-index Endpoint (Admin Only)
# -------------------------

# Track in-progress re-index jobs (in-memory — resets on restart, fine for hackathon)
_reindex_status: dict[str, str] = {}  # filename -> "running" | "done" | "error:<msg>"

def _do_reindex(filename: str, file_location: str) -> None:
    """Background task: remove old embeddings then re-ingest the document."""
    global _reindex_status
    logger.info("[Re-index] START — %s", filename)
    try:
        from rag_pipeline import vectorstore, ingest_document

        # 1. Remove existing embeddings for this file (Chroma filter by source metadata)
        try:
            existing = vectorstore.get(where={"source": file_location})
            ids_to_delete = existing.get("ids", [])
            if ids_to_delete:
                vectorstore.delete(ids=ids_to_delete)
                logger.info("[Re-index] Removed %d old chunks for %s", len(ids_to_delete), filename)
                # Verify deletion
                verify = vectorstore.get(where={"source": file_location})
                if len(verify.get("ids", [])) > 0:
                    logger.warning("[Re-index] Verification warning: old vectors still exist!")
            else:
                logger.info("[Re-index] No existing chunks found for %s (will add fresh)", filename)
        except Exception as del_err:
            logger.warning("[Re-index] Could not remove old chunks (non-fatal): %s", del_err)

        # 2. Re-ingest
        ingest_document(file_location)
        logger.info("[Re-index] DONE — %s", filename)
        _reindex_status[filename] = "done"
    except Exception as e:
        logger.error("[Re-index] FAILED — %s — %s", filename, str(e))
        _reindex_status[filename] = f"error:{str(e)}"

@app.post("/reindex/{filename}")
def reindex_document(
    filename: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_admin_user)
):
    file_location = os.path.join(UPLOAD_DIR, filename)
    if not os.path.exists(file_location):
        raise HTTPException(status_code=404, detail=f"File '{filename}' not found on disk.")

    if _reindex_status.get(filename) == "running":
        raise HTTPException(status_code=409, detail="Re-index already in progress for this file.")

    _reindex_status[filename] = "running"
    background_tasks.add_task(_do_reindex, filename, file_location)
    logger.info("[Re-index] Queued background task for %s", filename)
    log_activity(current_user.username, "Re-index", filename)
    return {"filename": filename, "status": "queued", "message": "Re-indexing started in the background."}

@app.get("/reindex/{filename}/status")
def get_reindex_status(
    filename: str,
    current_user: User = Depends(get_current_admin_user)
):
    status_val = _reindex_status.get(filename)
    if status_val is None:
        return {"filename": filename, "status": "idle"}
    if status_val == "running":
        return {"filename": filename, "status": "running"}
    if status_val == "done":
        return {"filename": filename, "status": "done"}
    # error:<msg>
    return {"filename": filename, "status": "error", "detail": status_val.split(":", 1)[-1]}

# -------------------------
# RAG Endpoint
# -------------------------

@app.post("/ask")
def ask_rag_deprecated(
    query: QueryRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    answer = rag_answer(query.question, db)
    return {
        "question": query.question,
        "answer": answer,
    }

# -------------------------
# Chat Session Endpoints
# -------------------------

@app.get("/sessions", response_model=list[ChatSessionResponse])
def get_sessions(
    search: str = None,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    query = db.query(ChatSession).filter(ChatSession.user_id == current_user.id)
    if search:
        search_term = f"%{search}%"
        query = query.outerjoin(ChatMessage).filter(
            (ChatSession.title.ilike(search_term)) |
            (ChatMessage.content.ilike(search_term))
        ).distinct()
    sessions = query.order_by(ChatSession.created_at.desc()).all()
    return sessions

@app.post("/sessions", response_model=ChatSessionResponse)
def create_session(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    new_session = ChatSession(user_id=current_user.id, title="New Chat")
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    return new_session

@app.get("/sessions/{session_id}/messages", response_model=list[ChatMessageResponse])
def get_session_messages(session_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    return session.messages

@app.post("/sessions/{session_id}/ask")
def ask_rag_session(
    session_id: int,
    query: QueryRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    
    # Update title if it's "New Chat" and this is the first message
    if session.title == "New Chat":
        session.title = query.question[:30] + ("..." if len(query.question) > 30 else "")
        db.commit()

    # Save user message
    user_msg = ChatMessage(session_id=session.id, role="user", content=query.question)
    db.add(user_msg)
    db.commit()

    # Call RAG (passing username for activity logging of failed retrievals)
    try:
        answer = rag_answer(query.question, db, current_user.username)
    except Exception as e:
        answer = f"Error generating response: {str(e)}"
    
    # Save assistant message
    asst_msg = ChatMessage(session_id=session.id, role="assistant", content=answer)
    db.add(asst_msg)
    db.commit()

    return {
        "question": query.question,
        "answer": answer,
    }

@app.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(session_id: int, current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    session = db.query(ChatSession).filter(ChatSession.id == session_id, ChatSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    db.delete(session)
    db.commit()
    return

# -------------------------
# FAQ Management (Admin/Manager Only)
# -------------------------

@app.get("/faq", response_model=list[FAQRuleResponse])
def get_faq_rules(
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    return db.query(FAQRule).all()

@app.post("/faq", response_model=FAQRuleResponse, status_code=status.HTTP_201_CREATED)
def create_faq_rule(
    rule: FAQRuleCreate,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    # check case-insensitive exact keyword match to avoid duplicate keywords
    existing = db.query(FAQRule).filter(func.lower(FAQRule.keyword) == func.lower(rule.keyword)).first()
    if existing:
        raise HTTPException(status_code=400, detail="FAQ rule with this keyword already exists")
    db_rule = FAQRule(
        keyword=rule.keyword,
        response=rule.response,
        is_active=rule.is_active
    )
    db.add(db_rule)
    db.commit()
    db.refresh(db_rule)
    log_activity(current_user.username, "FAQ Added", db_rule.keyword)
    return db_rule

@app.delete("/faq/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_faq_rule(
    id: int,
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    db_rule = db.query(FAQRule).filter(FAQRule.id == id).first()
    if not db_rule:
        raise HTTPException(status_code=404, detail="FAQ rule not found")
    keyword = db_rule.keyword
    db.delete(db_rule)
    db.commit()
    log_activity(current_user.username, "FAQ Deleted", keyword)
    return

# -------------------------
# Analytics & Knowledge Gaps (Admin/Manager Only)
# -------------------------

@app.get("/analytics/gaps", response_model=AnalyticsGapsResponse)
def get_analytics_gaps(
    current_user: User = Depends(get_current_admin_user),
    db: Session = Depends(get_db)
):
    # Calculate failed retrieval rate
    total_queries = db.query(ChatMessage).filter(ChatMessage.role == "user").count()
    total_failed = db.query(FailedRetrieval).count()
    
    failed_rate = 0.0
    if total_queries > 0:
        failed_rate = (total_failed / total_queries) * 100
        
    # Group failed retrievals by query_text
    gaps_query = db.query(
        FailedRetrieval.query_text,
        func.count(FailedRetrieval.id).label("failure_count"),
        func.max(FailedRetrieval.highest_score).label("highest_score"),
        func.max(FailedRetrieval.created_at).label("created_at")
    ).group_by(FailedRetrieval.query_text).order_by(func.count(FailedRetrieval.id).desc()).all()
    
    gaps_list = []
    for row in gaps_query:
        gaps_list.append({
            "query_text": row.query_text,
            "failure_count": row.failure_count,
            "highest_score": row.highest_score if row.highest_score is not None else 0.0,
            "created_at": row.created_at.isoformat() if row.created_at else ""
        })
        
    return {
        "failed_rate": f"{failed_rate:.1f}%",
        "total_failed": total_failed,
        "gaps": gaps_list
    }

@app.post("/logout")
def logout(current_user: User = Depends(get_current_user)):
    log_activity(current_user.username, "Logout")
    return {"message": "Logged out successfully"}

@app.get("/settings")
def get_settings(current_user: User = Depends(get_current_admin_user)):
    return load_settings()

@app.post("/settings")
def update_settings(
    settings: dict,
    current_user: User = Depends(get_current_admin_user)
):
    prompt = settings.get("system_prompt", "")
    # Validate and automatically restore placeholders if they are missing
    if "{context}" not in prompt or "{question}" not in prompt:
        if "{context}" not in prompt:
            prompt += "\n\nContext:\n{context}"
        if "{question}" not in prompt:
            prompt += "\n\nUser Question:\n{question}"
        settings["system_prompt"] = prompt
        
    save_settings(settings)
    return settings

@app.post("/settings/reset")
def reset_settings(current_user: User = Depends(get_current_admin_user)):
    save_settings(DEFAULT_SETTINGS.copy())
    return load_settings()

@app.get("/analytics/activity")
def get_analytics_activity(current_user: User = Depends(get_current_admin_user)):
    return get_activity_logs()

@app.get("/")
def health_check():
    return {"status": "RAG service v2 is running"}

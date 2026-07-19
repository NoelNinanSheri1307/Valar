import os
import shutil
import logging
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

# CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

UPLOAD_DIR = "uploaded_files"
os.makedirs(UPLOAD_DIR, exist_ok=True)

@app.post("/upload")
def upload_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_admin_user)
):
    file_location = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_location, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    # Ingest into RAG
    try:
        ingest_document(file_location)
    except Exception as e:
        # cleanup if failed (optional)
        # os.remove(file_location)
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {str(e)}")
        
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
def get_sessions(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    sessions = db.query(ChatSession).filter(ChatSession.user_id == current_user.id).order_by(ChatSession.created_at.desc()).all()
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

    # Call RAG
    try:
        answer = rag_answer(query.question, db)
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
    db.delete(db_rule)
    db.commit()
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

@app.get("/")
def health_check():
    return {"status": "RAG service v2 is running"}

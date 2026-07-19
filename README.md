# Note the UI and features is still under update ⚠️ .  

# Industrial & Engineering Intelligence Copilot

An industrial AI agent platform featuring Universal Document Ingestion, Expert Knowledge Copilot, Maintenance Intelligence, and Regulatory Compliance. Built with Next.js (Frontend) and FastAPI (Backend).

## Features

- **Authentication**: Secure Login and Registration system using JWT.
- **User Roles**:
    - **Manager**: Can upload PDFs, P&IDs, and maintenance records to the knowledge base.
    - **Technician**: Can query the Expert Knowledge Copilot for maintenance and operational intelligence.
- **Persistent RAG**: Uses ChromaDB (saved to disk) to remember uploaded files across restarts.
- **Modern UI**: Dark-themed, responsive chat interface.

## Architecture

```mermaid
graph LR
    User[Clients] --> Frontend[Next.js App]
    Frontend --> Auth[Auth System]
    Frontend --> Backend[FastAPI Server]
    Backend --> DB[(SQLite Users DB)]
    Backend --> VectorDB[(Chroma Vector DB)]
    Backend --> LLM[OpenRouter/LLM]
```

## Prerequisites

- Python 3.8+
- Node.js 18+

## Setup Guide

### 1. Backend Setup

Navigate to the Backend directory:
```bash
cd Backend
```

Create and activate virtual environment:
```bash
python -m venv env
# Windows
.\env\Scripts\activate
# Mac/Linux
source env/bin/activate
```

Install dependencies:
```bash
pip install -r requirements.txt
# Verify bcrypt compatibility
pip install "bcrypt<4.0.0"
```

Create a `.env` file in the `Backend` directory:
```env
OPENROUTER_API_KEY=your_api_key_here
SECRET_KEY=your_super_secret_jwt_key
```

Run the server:
```bash
uvicorn app:app --reload --port 8000
```
*Server runs at `http://localhost:8000`*

### 2. Frontend Setup

Navigate to the Frontend directory:
```bash
cd frontend
```

Install dependencies:
```bash
npm install
```

Create a `.env.local` file:
```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
```

Run the development server:
```bash
npm run dev
```
*App runs at `http://localhost:3000`*

## How to Use

1.  **Register**: Go to `http://localhost:3000/register`.
    *   Create an **Manager** account (select role: Manager).
    *   Create a **Technician** account.
2.  **Upload Knowledge (Manager)**:
    *   Login as Manager.
    *   Use the "Upload Knowledge" panel to upload PDF or Text files.
3.  **Chat (Technician/Manager)**:
    *   Login.
    *   Ask questions! The AI will answer based on the files you uploaded.

## API Endpoints

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/register` | Create a new user | No |
| `POST` | `/token` | Login (Returns JWT) | No |
| `POST` | `/upload` | Upload & Index File | **Yes (Manager)** |
| `POST` | `/ask` | Chat with RAG | **Yes** |
| `GET` | `/users/me` | Get current user info | **Yes** |

## Troubleshooting

**Error: `AttributeError: module 'bcrypt' has no attribute '__about__'`**
*   **Fix**: Run `pip install "bcrypt<4.0.0"` in your backend environment. This is a known compatibility issue with `passlib`.

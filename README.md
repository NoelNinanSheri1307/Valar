# Valar - Enterprise Customer Support Copilot

An enterprise customer support assistant platform featuring document ingestion, vector-retrieval chat, automated FAQ routing, and failed query analytics. Built with Next.js (Frontend) and FastAPI (Backend).

## Role-Based Operations

### Support Managers
* **Document Ingestion**: Upload and index technical manuals, pdf documents, and reference text sheets.
* **Canned FAQ Configuration**: Create and manage instant text matches to bypass LLM generation for common support requests.
* **Gap Analytics**: Monitor user searches that failed to yield relevant context in the database to identify areas where documentation needs updates.
* **Ticket Management**: Inspect, prioritize, and update the status of support tickets submitted by technicians.

### Technicians and Support Agents
* **Knowledge Retrieval**: Ask questions about engineering rules, safety specs, manual guidelines, and standard workflows.
* **Automatic Web Fallback**: If the local vector store has no relevant context, the system runs an external Exa web search to get relevant guidance.
* **Ticket Escalation**: Submit priority support tickets directly from the chat window when a query requires supervisor attention.
* **Chat Export**: Save chat logs as Markdown, plain text, or PDF documentation.
* **Session Management**: Access past conversation histories, search through active titles, and clean up logs by deleting sessions.

## Architecture

* **FAQ Matching**: Bypasses LLM generation for pre-configured keyword matches, applying longest-prefix matching.
* **Vector Store Retrieval**: Chroma db vector indexing using the OpenAI text-embedding-ada-002 model.
* **Relevance Check**: If context similarity score falls below 0.15, the search is logged as a documentation gap, and an Exa web search is executed.

## Setup Guide

### 1. Backend Setup

Navigate to the Backend directory:
```bash
cd Backend
```

Create and activate virtual environment:
```bash
python3 -m venv venv
# Windows
.\venv\Scripts\activate
# Mac/Linux
source venv/bin/activate
```

Install dependencies:
```bash
pip install -r requirements.txt
```

Create a .env file in the Backend directory:
```env
OPENROUTER_API_KEY=your_openrouter_api_key
EXA_API_KEY=your_exa_api_key
SECRET_KEY=your_jwt_secret_key
```

Run the server:
```bash
uvicorn app:app --reload --port 8000
```
The server runs at http://localhost:8000

### 2. Frontend Setup

Navigate to the frontend directory:
```bash
cd ../frontend
```

Install dependencies:
```bash
npm install
```

Create a .env.local file:
```env
NEXT_PUBLIC_BACKEND_URL=http://localhost:8000
```

Run the development server:
```bash
npm run dev
```
The application runs at http://localhost:3000

## API Endpoints

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| POST | /register | Create a new user account | No |
| POST | /token | Authenticate user (returns JWT) | No |
| POST | /upload | Upload and index knowledge base documents | Yes (Admin/Manager) |
| GET | /faq | Get list of all canned FAQ rules | Yes (Admin/Manager) |
| POST | /faq | Add a new canned FAQ rule | Yes (Admin/Manager) |
| DELETE | /faq/{id} | Remove a canned FAQ rule | Yes (Admin/Manager) |
| GET | /analytics/gaps | Get failed retrieval analytics and gap reports | Yes (Admin/Manager) |
| POST | /sessions | Create a chat session | Yes |
| DELETE | /sessions/{id} | Delete a chat session | Yes |
| POST | /sessions/{id}/ask | Query the RAG/FAQ chatbot | Yes |
| GET | /users/me | Fetch active user information | Yes |

## Troubleshooting

Error: AttributeError: module 'bcrypt' has no attribute '__about__'
* Fix: Run `pip install "bcrypt<4.0.0"` in the virtual environment. This resolves a dependency compatibility conflict between passlib and newer bcrypt versions.

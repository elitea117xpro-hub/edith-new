from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import sqlite3
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.getenv("EDITH_DB_PATH", str(BASE_DIR / "data" / "edith.db")))
DB_PATH.parent.mkdir(parents=True, exist_ok=True)
SESSION_TTL_DAYS = int(os.getenv("EDITH_SESSION_TTL_DAYS", "30"))
USERNAME_PATTERN = re.compile(r"^[A-Za-z0-9_.-]{3,24}$")

app = FastAPI(title="E.D.I.T.H.", version="1.0.0")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


@contextmanager
def db() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def init_db() -> None:
    with db() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS contacts (
                user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                contact_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                PRIMARY KEY (user_id, contact_id),
                CHECK (user_id != contact_id)
            );
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at TEXT NOT NULL,
                UNIQUE (user_a, user_b),
                CHECK (user_a < user_b)
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                body TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS call_records (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                caller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                call_type TEXT NOT NULL,
                started_at TEXT NOT NULL,
                ended_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
            CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
            """
        )


@app.on_event("startup")
def startup() -> None:
    init_db()


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 240_000)
    return f"pbkdf2_sha256$240000${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        _, iterations, salt_hex, digest_hex = encoded.split("$", 3)
        calculated = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(iterations)
        )
        return secrets.compare_digest(calculated.hex(), digest_hex)
    except (ValueError, TypeError):
        return False


def public_user(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
    }


def user_by_id(user_id: int) -> sqlite3.Row | None:
    with db() as connection:
        return connection.execute("SELECT id, username, display_name FROM users WHERE id = ?", (user_id,)).fetchone()


def session_user(token: str | None) -> sqlite3.Row | None:
    if not token:
        return None
    with db() as connection:
        row = connection.execute(
            """
            SELECT u.id, u.username, u.display_name
            FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
            """,
            (token, int(time.time())),
        ).fetchone()
        connection.execute("DELETE FROM sessions WHERE expires_at <= ?", (int(time.time()),))
        return row


def require_user(request: Request, edith_session: str | None = Cookie(default=None)) -> sqlite3.Row:
    user = session_user(edith_session)
    if not user:
        raise HTTPException(status_code=401, detail="Sign in required")
    return user


def create_session(user_id: int) -> str:
    token = secrets.token_urlsafe(42)
    expires_at = int(time.time()) + SESSION_TTL_DAYS * 86400
    with db() as connection:
        connection.execute(
            "INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, utc_now(), expires_at),
        )
    return token


def attach_session(response: JSONResponse, token: str, request: Request) -> None:
    forwarded = request.headers.get("x-forwarded-proto", "")
    secure = request.url.scheme == "https" or forwarded.split(",")[0].strip() == "https"
    response.set_cookie(
        "edith_session",
        token,
        max_age=SESSION_TTL_DAYS * 86400,
        httponly=True,
        secure=secure,
        samesite="none" if secure else "lax",
        path="/",
    )


class AuthPayload(BaseModel):
    username: str = Field(min_length=3, max_length=24)
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=48)


class LoginPayload(BaseModel):
    username: str
    password: str


class ContactPayload(BaseModel):
    username: str


class MessagePayload(BaseModel):
    body: str = Field(min_length=1, max_length=4000)


class CallHistoryPayload(BaseModel):
    conversation_id: int
    call_type: str = Field(pattern="^(voice|video)$")
    started_at: str | None = None
    ended_at: str | None = None


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "edith"}


@app.get("/api/config")
def public_config() -> dict[str, Any]:
    raw_ice = os.getenv("ICE_SERVERS_JSON", '[{"urls":["stun:stun.l.google.com:19302"]}]')
    try:
        ice_servers = json.loads(raw_ice)
    except json.JSONDecodeError:
        ice_servers = [{"urls": ["stun:stun.l.google.com:19302"]}]
    return {"ice_servers": ice_servers}


@app.post("/api/auth/register")
def register(payload: AuthPayload, request: Request) -> JSONResponse:
    username = payload.username.strip()
    if not USERNAME_PATTERN.fullmatch(username):
        raise HTTPException(status_code=400, detail="Username must be 3–24 letters, numbers, dots, dashes, or underscores")
    display_name = (payload.display_name or username).strip() or username
    with db() as connection:
        try:
            cursor = connection.execute(
                "INSERT INTO users(username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (username, display_name[:48], hash_password(payload.password), utc_now()),
            )
        except sqlite3.IntegrityError as error:
            if "username" in str(error).lower():
                raise HTTPException(status_code=409, detail="That username is already in use") from error
            raise
        user_id = int(cursor.lastrowid or 0)
        if not user_id:
            raise HTTPException(status_code=500, detail="Could not create user")
    token = create_session(user_id)
    created_user = user_by_id(user_id)
    if not created_user:
        raise HTTPException(status_code=500, detail="Could not load created user")
    response = JSONResponse({"user": public_user(created_user)})
    attach_session(response, token, request)
    return response


@app.post("/api/auth/login")
def login(payload: LoginPayload, request: Request) -> JSONResponse:
    with db() as connection:
        row = connection.execute("SELECT * FROM users WHERE username = ? COLLATE NOCASE", (payload.username.strip(),)).fetchone()
    if not row or not verify_password(payload.password, row["password_hash"]):
        raise HTTPException(status_code=401, detail="Username or password not recognized")
    token = create_session(row["id"])
    response = JSONResponse({"user": public_user(row)})
    attach_session(response, token, request)
    return response


@app.post("/api/auth/logout")
def logout(request: Request, edith_session: str | None = Cookie(default=None)) -> JSONResponse:
    if edith_session:
        with db() as connection:
            connection.execute("DELETE FROM sessions WHERE token = ?", (edith_session,))
    response = JSONResponse({"ok": True})
    response.delete_cookie("edith_session", path="/")
    return response


@app.get("/api/me")
def me(user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    return {"user": public_user(user)}


@app.get("/api/users/search")
def search_users(q: str = "", user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    query = q.strip()
    if len(query) < 2:
        return {"users": []}
    with db() as connection:
        rows = connection.execute(
            """
            SELECT id, username, display_name FROM users
            WHERE id != ? AND (username LIKE ? OR display_name LIKE ?)
            ORDER BY username LIMIT 20
            """,
            (user["id"], f"%{query}%", f"%{query}%"),
        ).fetchall()
    return {"users": [public_user(row) | {"online": manager.is_online(row["id"])} for row in rows]}


def contacts_for(user_id: int) -> list[dict[str, Any]]:
    with db() as connection:
        rows = connection.execute(
            """
            SELECT u.id, u.username, u.display_name
            FROM contacts c JOIN users u ON u.id = c.contact_id
            WHERE c.user_id = ? ORDER BY lower(u.display_name), lower(u.username)
            """,
            (user_id,),
        ).fetchall()
    return [public_user(row) | {"online": manager.is_online(row["id"])} for row in rows]


@app.get("/api/contacts")
def get_contacts(user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    return {"contacts": contacts_for(user["id"]) }


@app.post("/api/contacts")
def add_contact(payload: ContactPayload, user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    username = payload.username.strip()
    with db() as connection:
        contact = connection.execute("SELECT id, username, display_name FROM users WHERE username = ? COLLATE NOCASE", (username,)).fetchone()
        if not contact:
            raise HTTPException(status_code=404, detail="No E.D.I.T.H. user found with that username")
        if contact["id"] == user["id"]:
            raise HTTPException(status_code=400, detail="You cannot add yourself")
        now = utc_now()
        connection.execute("INSERT OR IGNORE INTO contacts(user_id, contact_id, created_at) VALUES (?, ?, ?)", (user["id"], contact["id"], now))
        connection.execute("INSERT OR IGNORE INTO contacts(user_id, contact_id, created_at) VALUES (?, ?, ?)", (contact["id"], user["id"], now))
    return {"contact": public_user(contact) | {"online": manager.is_online(contact["id"])} }


def conversation_row(connection: sqlite3.Connection, conversation_id: int, user_id: int) -> sqlite3.Row | None:
    return connection.execute(
        """
        SELECT c.id, c.user_a, c.user_b, u.id AS contact_id, u.username, u.display_name
        FROM conversations c
        JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
        WHERE c.id = ? AND (c.user_a = ? OR c.user_b = ?)
        """,
        (user_id, conversation_id, user_id, user_id),
    ).fetchone()


def ensure_conversation(user_id: int, contact_id: int) -> sqlite3.Row:
    low, high = sorted((user_id, contact_id))
    with db() as connection:
        connection.execute(
            "INSERT OR IGNORE INTO conversations(user_a, user_b, created_at) VALUES (?, ?, ?)",
            (low, high, utc_now()),
        )
        return connection.execute(
            """
            SELECT c.id, c.user_a, c.user_b, u.id AS contact_id, u.username, u.display_name
            FROM conversations c JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
            WHERE c.user_a = ? AND c.user_b = ?
            """,
            (user_id, low, high),
        ).fetchone()


@app.get("/api/conversations")
def list_conversations(user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    with db() as connection:
        rows = connection.execute(
            """
            SELECT c.id, c.user_a, c.user_b,
                   u.id AS contact_id, u.username, u.display_name,
                   m.body AS last_message, m.created_at AS last_message_at
            FROM conversations c
            JOIN users u ON u.id = CASE WHEN c.user_a = ? THEN c.user_b ELSE c.user_a END
            LEFT JOIN messages m ON m.id = (
                SELECT MAX(id) FROM messages WHERE conversation_id = c.id
            )
            WHERE c.user_a = ? OR c.user_b = ?
            ORDER BY COALESCE(m.created_at, c.created_at) DESC
            """,
            (user["id"], user["id"], user["id"]),
        ).fetchall()
    return {
        "conversations": [
            {
                "id": row["id"],
                "contact": {"id": row["contact_id"], "username": row["username"], "display_name": row["display_name"], "online": manager.is_online(row["contact_id"])},
                "last_message": row["last_message"],
                "last_message_at": row["last_message_at"],
            }
            for row in rows
        ]
    }


@app.post("/api/conversations/{contact_id}")
def open_conversation(contact_id: int, user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    contact = user_by_id(contact_id)
    if not contact or contact_id == user["id"]:
        raise HTTPException(status_code=404, detail="Contact not found")
    conversation = ensure_conversation(user["id"], contact_id)
    return {"conversation": {"id": conversation["id"], "contact": public_user(contact) | {"online": manager.is_online(contact_id)}}}


@app.get("/api/conversations/{conversation_id}/messages")
def list_messages(conversation_id: int, user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    with db() as connection:
        conversation = conversation_row(connection, conversation_id, user["id"])
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
        rows = connection.execute(
            "SELECT id, sender_id, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC LIMIT 500",
            (conversation_id,),
        ).fetchall()
    return {"messages": [dict(row) for row in rows]}


@app.post("/api/conversations/{conversation_id}/messages")
def send_message(conversation_id: int, payload: MessagePayload, user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    body = payload.body.strip()
    if not body:
        raise HTTPException(status_code=400, detail="Message cannot be empty")
    with db() as connection:
        conversation = conversation_row(connection, conversation_id, user["id"])
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
        created_at = utc_now()
        cursor = connection.execute(
            "INSERT INTO messages(conversation_id, sender_id, body, created_at) VALUES (?, ?, ?, ?)",
            (conversation_id, user["id"], body, created_at),
        )
        message = {"id": cursor.lastrowid, "conversation_id": conversation_id, "sender_id": user["id"], "body": body, "created_at": created_at}
        recipient_id = conversation["contact_id"]
    manager.send_to(user["id"], {"type": "message", "message": message})
    manager.send_to(recipient_id, {"type": "message", "message": message})
    return {"message": message}


@app.post("/api/calls/history")
def call_history(payload: CallHistoryPayload, user: sqlite3.Row = Depends(require_user)) -> dict[str, Any]:
    with db() as connection:
        conversation = conversation_row(connection, payload.conversation_id, user["id"])
        if not conversation:
            raise HTTPException(status_code=404, detail="Conversation not found")
        cursor = connection.execute(
            "INSERT INTO call_records(conversation_id, caller_id, call_type, started_at, ended_at) VALUES (?, ?, ?, ?, ?)",
            (payload.conversation_id, user["id"], payload.call_type, payload.started_at or utc_now(), payload.ended_at),
        )
    return {"call_id": cursor.lastrowid}


class ConnectionManager:
    def __init__(self) -> None:
        self.connections: dict[int, set[WebSocket]] = {}

    def is_online(self, user_id: int) -> bool:
        return bool(self.connections.get(user_id))

    async def connect(self, user_id: int, websocket: WebSocket) -> None:
        await websocket.accept()
        self.connections.setdefault(user_id, set()).add(websocket)
        await self.broadcast_presence()

    def disconnect(self, user_id: int, websocket: WebSocket) -> None:
        sockets = self.connections.get(user_id, set())
        sockets.discard(websocket)
        if not sockets:
            self.connections.pop(user_id, None)

    async def broadcast_presence(self) -> None:
        online = list(self.connections.keys())
        for sockets in list(self.connections.values()):
            for socket in list(sockets):
                try:
                    await socket.send_json({"type": "presence", "online_user_ids": online})
                except Exception:
                    pass

    def send_to(self, user_id: int, payload: dict[str, Any]) -> None:
        sockets = list(self.connections.get(user_id, set()))
        for socket in sockets:
            import asyncio
            asyncio.create_task(self._send(socket, payload))

    async def _send(self, socket: WebSocket, payload: dict[str, Any]) -> None:
        try:
            await socket.send_json(payload)
        except Exception:
            pass


manager = ConnectionManager()


def websocket_user(websocket: WebSocket) -> sqlite3.Row | None:
    cookie_header = websocket.headers.get("cookie", "")
    cookies: dict[str, str] = {}
    for part in cookie_header.split(";"):
        if "=" in part:
            key, value = part.strip().split("=", 1)
            cookies[key] = value
    return session_user(cookies.get("edith_session"))


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    user = websocket_user(websocket)
    if not user:
        await websocket.close(code=4401)
        return
    await manager.connect(user["id"], websocket)
    try:
        while True:
            payload = await websocket.receive_json()
            kind = payload.get("type")
            target_id = payload.get("to_user_id")
            if kind in {"call-offer", "call-answer", "ice-candidate", "call-decline", "call-end", "call-busy", "typing"} and target_id:
                manager.send_to(
                    int(target_id),
                    {
                        **payload,
                        "from_user_id": user["id"],
                        "from_username": user["username"],
                    },
                )
    except WebSocketDisconnect:
        manager.disconnect(user["id"], websocket)
        await manager.broadcast_presence()
    except Exception:
        manager.disconnect(user["id"], websocket)
        await manager.broadcast_presence()


@app.get("/")
def index() -> FileResponse:
    return FileResponse(BASE_DIR / "templates" / "index.html")


@app.get("/manus-routes.json")
def route_manifest() -> FileResponse:
    return FileResponse(BASE_DIR / "manus-routes.json", media_type="application/json")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")

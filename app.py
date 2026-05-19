import os
import sqlite3
import secrets
import shutil
from typing import Optional
from fastapi import FastAPI, Depends, HTTPException, Header, UploadFile, File, Form
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import httpx

DB_FILE = "data.db"
UPLOAD_DIR = "uploads"
os.makedirs(UPLOAD_DIR, exist_ok=True)

app = FastAPI(title="Public Album Backend")

# --- 数据库初始化 ---
def get_db():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY, value TEXT
            )""")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS albums (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL, description TEXT
            )""")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS photos (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                album_id INTEGER, url TEXT NOT NULL, title TEXT,
                FOREIGN KEY(album_id) REFERENCES albums(id) ON DELETE CASCADE
            )""")
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS tokens (
                token TEXT PRIMARY KEY, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )""")
        
        # 初始化默认数据
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('password', 'admin123')")
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('storage_mode', 'local')")
        cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('smms_token', '')")
        
        # 如果没有相册，默认建一个
        cursor.execute("SELECT COUNT(*) FROM albums")
        if cursor.fetchone()[0] == 0:
            cursor.execute("INSERT INTO albums (name, description) VALUES ('默认相册', '系统自动创建的第一个相册')")
        conn.commit()

init_db()

# --- 权限校验中间件 ---
def verify_token(x_admin_token: Optional[str] = Header(None), db=Depends(get_db)):
    if not x_admin_token:
        raise HTTPException(status_code=401, detail="鉴权失败，请重新登录")
    cursor = db.cursor()
    cursor.execute("SELECT token FROM tokens WHERE token = ?", (x_admin_token,))
    if not cursor.fetchone():
        raise HTTPException(status_code=401, detail="会话已过期，请重新登录")
    return x_admin_token

# --- 基础实体定义 ---
class AuthQuery(BaseModel):
    password: str

class AlbumSchema(BaseModel):
    name: str
    description: Optional[str] = ""

class PhotoUrlSchema(BaseModel):
    url: str
    album_id: int
    title: Optional[str] = ""

class SettingsSchema(BaseModel):
    storage_mode: str
    smms_token: Optional[str] = ""
    new_password: Optional[str] = None

# --- API 路由路由 ---

@app.post("/api/auth")
def auth(data: AuthQuery, db=Depends(get_db)):
    cursor = db.cursor()
    cursor.execute("SELECT value FROM settings WHERE key='password'")
    if cursor.fetchone()["value"] == data.password:
        token = secrets.token_hex(24)
        cursor.execute("INSERT INTO tokens (token) VALUES (?)", (token,))
        db.commit()
        return {"token": token}
    raise HTTPException(status_code=401, detail="管理密码错误")

@app.get("/api/verify-token")
def verify(_token=Depends(verify_token)):
    return {"status": "ok"}

# --- 相册管理 ---
@app.get("/api/albums")
def get_albums(db=Depends(get_db)):
    cursor = db.cursor()
    cursor.execute("SELECT id, name, description FROM albums")
    return {"albums": [dict(r) for r in cursor.fetchall()]}

@app.post("/api/albums")
def create_album(data: AlbumSchema, db=Depends(get_db), _tk=Depends(verify_token)):
    cursor = db.cursor()
    cursor.execute("INSERT INTO albums (name, description) VALUES (?, ?)", (data.name, data.description))
    db.commit()
    return {"status": "success"}

@app.put("/api/albums/{album_id}")
def update_album(album_id: int, data: AlbumSchema, db=Depends(get_db), _tk=Depends(verify_token)):
    cursor = db.cursor()
    cursor.execute("UPDATE albums SET name=?, description=? WHERE id=?", (data.name, data.description, album_id))
    db.commit()
    return {"status": "success"}

# --- 图片管理 ---
@app.get("/api/photos")
def get_photos(album_id: Optional[str] = None, db=Depends(get_db)):
    cursor = db.cursor()
    if album_id and album_id != 'all':
        cursor.execute("SELECT id, album_id, url, title FROM photos WHERE album_id = ?", (album_id,))
    else:
        cursor.execute("SELECT id, album_id, url, title FROM photos ORDER BY id DESC")
    return {"photos": [dict(r) for r in cursor.fetchall()]}

@app.post("/api/photos/url")
def add_photo_url(data: PhotoUrlSchema, db=Depends(get_db), _tk=Depends(verify_token)):
    cursor = db.cursor()
    cursor.execute("INSERT INTO photos (album_id, url, title) VALUES (?, ?, ?)", (data.album_id, data.url, data.title))
    db.commit()
    return {"status": "success"}

@app.post("/api/photos")
async def add_photo_file(
    file: UploadFile = File(...), album_id: int = Form(...), title: str = Form(""),
    db=Depends(get_db), _tk=Depends(verify_token)
):
    cursor = db.cursor()
    cursor.execute("SELECT value FROM settings WHERE key='storage_mode'")
    mode = cursor.fetchone()["value"]
    
    if mode == "smms":
        cursor.execute("SELECT value FROM settings WHERE key='smms_token'")
        token = cursor.fetchone()["value"]
        async with httpx.AsyncClient() as client:
            files = {'smfile': (file.filename, await file.read(), file.content_type)}
            res = await client.post('https://sm.ms/api/v2/upload', files=files, headers={'Authorization': token})
            res_j = res.json()
            if res_j.get('success'):
                img_url = res_j['data']['url']
            elif res_j.get('code') == 'image_repeated':
                img_url = res_j.get('images', '') or res_j.get('data', '')
            else:
                raise HTTPException(status_code=400, detail=res_j.get('message', '图床上传失败'))
    else:
        # 本地存储模式
        ext = os.path.splitext(file.filename)[1]
        filename = f"{secrets.token_hex(12)}{ext}"
        filepath = os.path.join(UPLOAD_DIR, filename)
        with open(filepath, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        img_url = f"/uploads/{filename}"
        
    cursor.execute("INSERT INTO photos (album_id, url, title) VALUES (?, ?, ?)", (album_id, img_url, title))
    db.commit()
    return {"status": "success"}

@app.delete("/api/photos/{photo_id}")
def delete_photo(photo_id: int, db=Depends(get_db), _tk=Depends(verify_token)):
    cursor = db.cursor()
    cursor.execute("SELECT url FROM photos WHERE id = ?", (photo_id,))
    row = cursor.fetchone()
    if row and row["url"].startswith("/uploads/"):
        filename = row["url"].replace("/uploads/", "")
        filepath = os.path.join(UPLOAD_DIR, filename)
        if os.path.exists(filepath):
            try: os.remove(filepath)
            except: pass
    cursor.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
    db.commit()
    return {"status": "success"}

# --- 系统设置 ---
@app.get("/api/settings")
def get_settings(db=Depends(get_db), _tk=Depends(verify_token)):
    cursor = db.cursor()
    cursor.execute("SELECT key, value FROM settings")
    s = {r["key"]: r["value"] for r in cursor.fetchall()}
    return {"storage_mode": s.get("storage_mode", "local"), "smms_token": s.get("smms_token", "")}

@app.put("/api/settings")
def update_settings(data: SettingsSchema, db=Depends(get_db), _tk=Depends(verify_token)):
    cursor = db.cursor()
    cursor.execute("UPDATE settings SET value=? WHERE key='storage_mode'", (data.storage_mode,))
    cursor.execute("UPDATE settings SET value=? WHERE key='smms_token'", (data.smms_token or "",))
    if data.new_password:
        cursor.execute("UPDATE settings SET value=? WHERE key='password'", (data.new_password,))
    db.commit()
    return {"status": "success"}

# --- 静态资源托管 ---
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

@app.get("/", response_class=HTMLResponse)
def read_root():
    index_path = os.path.join(os.path.dirname(__file__), "index.html")
    if os.path.exists(index_path):
        with open(index_path, "r", encoding="utf-8") as f:
            return f.read()
    return "<h3>Backend is running. Please place index.html in the same directory.</h3>"

const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');

// ---------- 初始化 Express ----------
const app = express();
app.use(express.json());

// 静态文件服务（前端页面） —— 您可以将 index.html 放入 public 目录
app.use(express.static(path.join(__dirname, 'public')));
// 如果本地存储模式，提供上传文件访问
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- 数据库初始化 ----------
const db = new Database('album.db');
db.pragma('journal_mode = WAL');

// 建表
db.exec(`
  CREATE TABLE IF NOT EXISTS albums (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    album_id INTEGER NOT NULL,
    title TEXT DEFAULT '',
    url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    storage_mode TEXT DEFAULT 'local',
    smms_token TEXT DEFAULT '',
    password_hash TEXT NOT NULL
  );
`);

// 初始化默认设置（仅第一次运行）
const existingSettings = db.prepare('SELECT id FROM settings WHERE id = 1').get();
if (!existingSettings) {
  const defaultPassword = 'admin123';
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(defaultPassword, salt);
  db.prepare('INSERT INTO settings (id, storage_mode, smms_token, password_hash) VALUES (1, ?, ?, ?)').run('local', '', hash);
  console.log('✅ 数据库初始化完成，默认密码: admin123');
}

// ---------- 管理员认证 ----------
let currentAdminToken = null; // 内存中保存登录 token

// 验证管理员中间件
function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || token !== currentAdminToken) {
    return res.status(401).json({ detail: '未授权，请先登录管理后台' });
  }
  next();
}

// ---------- 文件上传配置（使用内存存储） ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件格式，仅支持 JPG/PNG/WebP/GIF'));
    }
  }
});

// ---------- 工具函数 ----------
// SM.MS 图床上传
async function uploadToSmms(fileBuffer, originalName, token) {
  const form = new FormData();
  form.append('smfile', fileBuffer, {
    filename: originalName,
    contentType: 'image/*'
  });

  const response = await axios.post('https://sm.ms/api/v2/upload', form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': token
    },
    timeout: 30000
  });

  if (response.data && response.data.success) {
    return response.data.data.url;
  } else {
    throw new Error(response.data?.message || '图床上传失败');
  }
}

// 保存文件到本地
function saveToLocal(fileBuffer, originalName) {
  const ext = path.extname(originalName) || '.jpg';
  const filename = uuidv4() + ext;
  const uploadDir = path.join(__dirname, 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  fs.writeFileSync(path.join(uploadDir, filename), fileBuffer);
  return `/uploads/${filename}`;
}

// ---------- API 路由 ----------

// 认证
app.post('/api/auth', (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ detail: '请输入密码' });

    const settings = db.prepare('SELECT password_hash FROM settings WHERE id = 1').get();
    if (!bcrypt.compareSync(password, settings.password_hash)) {
      return res.status(401).json({ detail: '密码错误' });
    }

    // 生成新的 token（旧 token 自动失效）
    currentAdminToken = uuidv4();
    res.json({ token: currentAdminToken });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 验证 token
app.get('/api/verify-token', requireAdmin, (req, res) => {
  res.json({ valid: true });
});

// 获取所有相册（公开）
app.get('/api/albums', (req, res) => {
  try {
    const albums = db.prepare('SELECT * FROM albums ORDER BY created_at DESC').all();
    res.json({ albums });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 创建相册（需管理员）
app.post('/api/albums', requireAdmin, (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ detail: '相册名称不能为空' });

    const result = db.prepare('INSERT INTO albums (name, description) VALUES (?, ?)').run(name.trim(), description || '');
    res.json({ id: result.lastInsertRowid, name: name.trim(), description: description || '' });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 更新相册
app.put('/api/albums/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ detail: '相册名称不能为空' });

    const result = db.prepare('UPDATE albums SET name = ?, description = ? WHERE id = ?').run(name.trim(), description || '', id);
    if (result.changes === 0) return res.status(404).json({ detail: '相册不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 删除相册（级联删除照片）
app.delete('/api/albums/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM albums WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ detail: '相册不存在' });
    // 同时删除该相册下的照片（外键约束已处理）
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 获取照片（公开）
app.get('/api/photos', (req, res) => {
  try {
    const { album_id } = req.query;
    let photos;
    if (album_id && album_id !== 'all') {
      photos = db.prepare('SELECT * FROM photos WHERE album_id = ? ORDER BY created_at DESC').all(album_id);
    } else {
      photos = db.prepare('SELECT * FROM photos ORDER BY created_at DESC').all();
    }
    res.json({ photos });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 上传照片（需管理员）
app.post('/api/photos', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ detail: '请选择要上传的文件' });

    const { album_id, title } = req.body;
    if (!album_id) return res.status(400).json({ detail: '请指定相册' });

    const settings = db.prepare('SELECT storage_mode, smms_token FROM settings WHERE id = 1').get();
    let photoUrl = '';

    // 根据存储模式处理文件
    if (settings.storage_mode === 'smms') {
      if (!settings.smms_token) return res.status(400).json({ detail: 'SM.MS Token 未设置' });
      photoUrl = await uploadToSmms(req.file.buffer, req.file.originalname, settings.smms_token);
    } else {
      // 默认本地存储（local）
      photoUrl = saveToLocal(req.file.buffer, req.file.originalname);
    }

    // 保存数据库记录
    const finalTitle = title || req.file.originalname.replace(/\.[^.]+$/, '');
    const result = db.prepare('INSERT INTO photos (album_id, title, url) VALUES (?, ?, ?)').run(album_id, finalTitle, photoUrl);
    res.json({ id: result.lastInsertRowid, url: photoUrl });
  } catch (err) {
    res.status(500).json({ detail: err.message || '上传失败' });
  }
});

// 通过 URL 添加照片（需管理员）
app.post('/api/photos/url', requireAdmin, (req, res) => {
  try {
    const { url, album_id, title } = req.body;
    if (!url) return res.status(400).json({ detail: '图片URL不能为空' });
    if (!album_id) return res.status(400).json({ detail: '请指定相册' });

    const finalTitle = title || '未命名';
    const result = db.prepare('INSERT INTO photos (album_id, title, url) VALUES (?, ?, ?)').run(album_id, finalTitle, url);
    res.json({ id: result.lastInsertRowid, url });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 删除照片（需管理员）
app.delete('/api/photos/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM photos WHERE id = ?').run(id);
    if (result.changes === 0) return res.status(404).json({ detail: '照片不存在' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 获取设置（需管理员）
app.get('/api/settings', requireAdmin, (req, res) => {
  try {
    const settings = db.prepare('SELECT storage_mode, smms_token FROM settings WHERE id = 1').get();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 更新设置（需管理员）
app.put('/api/settings', requireAdmin, (req, res) => {
  try {
    const { storage_mode, smms_token, new_password } = req.body;
    const updates = {};
    
    if (storage_mode) {
      if (!['local', 'smms', 'url_only'].includes(storage_mode)) {
        return res.status(400).json({ detail: '无效的存储模式' });
      }
      updates.storage_mode = storage_mode;
    }
    if (smms_token !== undefined) {
      updates.smms_token = smms_token;
    }
    if (new_password) {
      const salt = bcrypt.genSaltSync(10);
      updates.password_hash = bcrypt.hashSync(new_password, salt);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ detail: '没有需要更新的内容' });
    }

    // 动态构造 SQL
    const setClauses = [];
    const values = [];
    for (const [key, value] of Object.entries(updates)) {
      setClauses.push(`${key} = ?`);
      values.push(value);
    }
    values.push(1); // WHERE id = 1

    db.prepare(`UPDATE settings SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

    // 如果修改了密码，让当前 token 失效（需要重新登录）
    if (new_password) {
      currentAdminToken = null;
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ detail: err.message });
  }
});

// 前端路由回退（SPA）
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- 启动服务 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 相册服务已启动：http://localhost:${PORT}`);
});

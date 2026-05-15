# Telegram 私聊中转机器人

让两个用户通过机器人互相私聊，支持实名/匿名模式、屏蔽、邀请确认等完整功能。

## 快速开始

### 1. 获取 Bot Token

1. 在 Telegram 中找到 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示创建机器人
3. 复制获得的 Token

### 2. 配置

编辑 `config.py`：

```python
BOT_TOKEN = "你的Token"
ADMIN_IDS = [你的用户ID]   # 可选，管理员列表
ANONYMOUS_MODE = False      # True = 匿名模式
```

### 3. 安装依赖

```bash
pip install -r requirements.txt
```

### 4. 启动

```bash
python bot.py
```

---

## 功能说明

### 用户命令

| 命令 | 说明 |
|------|------|
| `/start` | 启动机器人 |
| `/chat @用户名` | 向对方发起私聊邀请 |
| `/end` | 结束当前会话 |
| `/block` | 屏蔽当前对话者 |
| `/unblock @用户名` | 取消屏蔽某用户 |
| `/status` | 查看当前会话状态 |
| `/help` | 帮助信息 |

### 管理员命令

| 命令 | 说明 |
|------|------|
| `/ban 用户ID` | 封禁用户 |
| `/unban 用户ID` | 解封用户 |
| `/stats` | 查看统计数据 |

### 支持的消息类型

- 文字消息
- 图片 / 视频 / 文件
- 语音 / 音频
- 贴纸 / 圆形视频
- 位置信息

### 会话流程

```
用户A /chat @用户B
      ↓
用户B 收到邀请 [接受] / [拒绝]
      ↓ 接受
双方进入活跃会话，消息自动转发
      ↓
任意一方 /end 结束会话
```

### 隐私说明

- **实名模式**：显示用户名或昵称
- **匿名模式**：显示随机6位ID（`匿名用户#A1B2C3`），双方无法知道对方真实身份

---

## 数据库结构

使用 SQLite（`chat.db`），包含以下表：

- `users` — 用户信息
- `sessions` — 会话记录（pending/active/closed）
- `blocked_users` — 屏蔽关系
- `messages` — 消息日志

---

## 部署到服务器

推荐使用 `systemd` 保持后台运行：

```ini
# /etc/systemd/system/tgbot.service
[Unit]
Description=Telegram Private Chat Bot
After=network.target

[Service]
WorkingDirectory=/opt/telegram_private_chat_bot
ExecStart=/usr/bin/python3 bot.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable tgbot
sudo systemctl start tgbot
```

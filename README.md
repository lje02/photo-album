git clone https://github.com/你的用户名/photo-album.git
cd photo-album
bash install.sh


bash install.sh          # 默认：构建 + 本地预览（localhost:3000）
bash install.sh --dev    # 开发模式，热重载（localhost:5173）
bash install.sh --build  # 仅构建 dist/，用于上传到服务器

photo-album/
├── src/
│   ├── App.jsx        # 主应用（localStorage 替代 window.storage）
│   └── main.jsx
├── index.html
├── vite.config.js
├── package.json
├── install.sh         # 一键安装脚本 ← 核心
├── .gitignore
└── README.md

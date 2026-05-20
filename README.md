apt-get update

apt-get install -y build-essential python3


# 下载并安装 nvm：
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# 代替重启 shell
\. "$HOME/.nvm/nvm.sh"

# 下载并安装 Node.js：
nvm install 24

# 验证 Node.js 版本：
node -v # Should print "v24.15.0".

# 验证 npm 版本：
npm -v # Should print "11.12.1".



curl -o- https://raw.githubusercontent.com/lje02/album-app/main/install.sh | sudo bash

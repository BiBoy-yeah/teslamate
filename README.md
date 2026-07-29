# TeslaMate Dashboard Demo

TeslaMate 自定义数据看板 —— 完整的后端 + 前端 Demo。

## 功能

- 实时车辆状态（电量、里程、状态）
- 电池电量趋势图（24小时 / 7天 / 30天）
- 最近行程列表
- 最近充电记录
- 自动刷新（每30秒）
- 响应式布局，支持手机端

## 项目结构

```
.
├── package.json          # 依赖配置
├── server.js             # Express 后端 API
├── .env.example          # 环境变量模板（可上传到 GitHub）
├── .gitignore            # Git 忽略规则（已配置保留 .env.example）
├── README.md             # 本文件
└── public/
    └── index.html        # 前端页面（单文件，零构建）
```

## 快速开始

### 1. 本地开发

```bash
# 安装依赖
npm install

# 复制环境变量模板并填写真实配置
cp .env.example .env
# 编辑 .env，填入你的 Railway PostgreSQL 连接信息

# 启动开发服务器
npm run dev
```

访问 http://localhost:3000

### 2. 部署到 Railway

#### 方式 A：GitHub 仓库部署（推荐）

1. 把本代码推送到 GitHub 仓库
2. 在 Railway 项目里点击 **New** → **Service** → **GitHub Repo**
3. 选择你的仓库，Railway 自动识别 `package.json`
4. 添加环境变量：

| 变量 | 值 |
|------|-----|
| `DATABASE_HOST` | `${{Postgres.PGHOST}}` |
| `DATABASE_PORT` | `${{Postgres.PGPORT}}` |
| `DATABASE_NAME` | `${{Postgres.PGDATABASE}}` |
| `DATABASE_USER` | `${{Postgres.PGUSER}}` |
| `DATABASE_PASS` | `${{Postgres.PGPASSWORD}}` |
| `DATABASE_SSL` | `true` |

5. 暴露端口 `3000`，生成域名
6. 访问域名即可

#### 方式 B：Docker Image

```bash
# 本地构建并推送
docker build -t yourname/teslamate-dashboard .
docker push yourname/teslamate-dashboard
```

然后在 Railway 选择 "Docker Image" 部署。

## 环境变量

| 变量 | 必填 | 说明 |
|------|------|------|
| `DATABASE_HOST` | ✅ | PostgreSQL 主机 |
| `DATABASE_PORT` | ❌ | 端口，默认 5432 |
| `DATABASE_NAME` | ✅ | 数据库名 |
| `DATABASE_USER` | ✅ | 用户名 |
| `DATABASE_PASS` | ✅ | 密码 |
| `DATABASE_SSL` | ❌ | Railway 建议设为 `true` |
| `PORT` | ❌ | 服务端口，默认 3000 |

## API 端点

| 端点 | 说明 |
|------|------|
| `GET /api/health` | 健康检查 |
| `GET /api/cars` | 车辆列表 |
| `GET /api/car-status` | 实时状态 |
| `GET /api/battery-history?days=7` | 电池历史 |
| `GET /api/recent-drives?limit=10` | 最近行程 |
| `GET /api/recent-charges?limit=10` | 最近充电 |
| `GET /api/monthly-stats` | 月度统计 |

## 安全提醒

⚠️ 当前 Demo **没有用户认证**。部署到公网前，建议：
1. 添加 JWT / Session 认证
2. 或用 Nginx 加 Basic Auth
3. 限制 Railway 域名为私有

## License

MIT

# TokenDance Field · 自托管版

单容器的专家局部判断系统。Next.js 同时提供前端与 API，SQLite 数据库存放在 Docker volume 中，Nginx 只反代本机端口。

## 生产结构

- 容器内端口：`8800`
- 服务器回环端口：`127.0.0.1:8021`
- 数据库：`/data/tokendance-field.sqlite`
- volume：`tokendance_field_data`
- 访问保护：HTTP Basic Auth，由 `.env` 中的 `FIELD_ACCESS_USER` 与 `FIELD_ACCESS_PASSWORD` 控制
- 健康检查：`/api/health`
- Nginx 模板：`nginx/www.field.tokendance.cool.conf`

## 构建与部署

```bash
DOCKER_BUILDKIT=1 docker buildx build --platform linux/amd64 -f Dockerfile.prod -t tokendance-field:latest --load .
docker save tokendance-field:latest | gzip > /tmp/tokendance-field.tar.gz
```

服务器端将 `docker-compose.prod.yml` 与 `.env` 放入同一目录，加载镜像后执行：

```bash
docker load -i /tmp/tokendance-field.tar.gz
docker compose -f docker-compose.prod.yml up -d field
curl -fsS http://127.0.0.1:8021/api/health
```

正式域名 `www.field.tokendance.cool` 由 Nginx 反代至 `http://127.0.0.1:8021`。不要把 8021 直接暴露到公网。

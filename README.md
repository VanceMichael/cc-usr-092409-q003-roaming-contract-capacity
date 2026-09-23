# 充电会话离线清分服务

        用于拼接站点离线补传的充电计量片段。项目采用 Koa 与 TypeScript，保留独立迁移进程和可注入的应用构造函数。

        ## 本地约定

        数据库默认写入 `data/charging.sqlite3`，可通过 `APP_DB_PATH` 改为当前工程内的其他文件。服务不需要远程数据库或缓存。

        ## 常用命令

        ```bash
        npm install
npm run db:upgrade
npm test
npm start
        ```

        Docker 镜像在构建阶段执行自动化测试，运行时监听 `PORT` 指定的端口，未设置时使用 8080。

## 编译或构建

```bash
npm run build
```

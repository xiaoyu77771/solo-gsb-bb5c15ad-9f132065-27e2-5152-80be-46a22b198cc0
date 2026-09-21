# Offline Package Dependency Resolver

基于 Node.js、Express 与 [`semver`](https://www.npmjs.com/package/semver) 的离线依赖解析服务。请求会携带完整的本地 registry，服务不会访问外部网络。

## 单条命令启动

```bash
docker compose up --build -d
```

启动后访问：

- 健康检查：`http://localhost:3000/health`
- 解析接口：`http://localhost:3000/resolve`
- 更新计划接口：`http://localhost:3000/update-plan`

停止服务：

```bash
docker compose down
```

## 必要配置

Docker Compose 已提供可直接运行的默认配置，无需额外环境变量。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 容器监听端口 |
| `HOST` | `0.0.0.0` | 容器监听地址 |
| `HOST_PORT` | `3000` | 宿主机映射端口 |
| `JSON_BODY_LIMIT` | `1mb` | 请求体大小上限 |
| `NODE_ENV` | `production` | Node.js 运行环境 |

如需改用宿主机 `8080`：

```bash
HOST_PORT=8080 docker compose up --build
```

此时访问 `http://localhost:8080/health`。

## API

### `GET /health`

返回示例：

```json
{
  "status": "ok",
  "service": "offline-dependency-resolver",
  "uptime": 1.234,
  "timestamp": "2026-09-21T00:00:00.000Z"
}
```

### `POST /resolve`

请求体：

- `registry`：离线包注册表，按“包名 → 版本 → 元数据”组织。
- `registry.<package>.<version>.dependencies`：可选，值为“依赖名 → semver 范围”。
- `root`：根约束，值为“包名 → semver 范围”。

示例：

```bash
curl -s -X POST http://localhost:3000/resolve \
  -H 'Content-Type: application/json' \
  -d '{
    "registry": {
      "app": {
        "2.0.0": { "dependencies": { "lib": "^2.0.0" } },
        "1.1.0": { "dependencies": { "lib": "^1.0.0" } }
      },
      "lib": {
        "2.0.0": {},
        "1.5.0": {}
      }
    },
    "root": {
      "app": "^1.0.0"
    }
  }'
```

成功时返回 `200`：

```json
{
  "satisfiable": true,
  "plan": [
    { "package": "app", version": "1.1.0" },
    { "package": "lib", version": "1.5.0" }
  ]
}
```

`plan` 包含所有根依赖及传递依赖，每个包只选择一个满足全部约束的版本。

### `POST /update-plan`

在 `/resolve` 的基础上根据当前锁定版本计算升级计划。请求体：

- `registry`、`root`：与 `/resolve` 相同。
- `locked`：当前锁定版本，按“包名 → 版本”组织；版本必须是合法 semver。锁定包可以不在 registry 中（视为可被移除）。
- `update`：升级约束，按“包名 → semver 范围”组织；与 `root` 一样作为顶层约束生效，可将新包引入计划。

求解目标按优先级依次为：

1. 满足全部 semver 约束（`root`、`update` 及传递依赖约束）；
2. 相对 `locked` 的变更包数量最少（新增、删除、换版各计 1 次）；
3. 仍有并列时，按包名字典序逐项比较，优先选择更高版本（包含该包的计划优于不包含的）。

示例：

```bash
curl -s -X POST http://localhost:3000/update-plan \
  -H 'Content-Type: application/json' \
  -d '{
    "registry": {
      "app": { "1.0.0": {} },
      "lib": {
        "2.1.0": {},
        "1.2.0": {}
      }
    },
    "root": {
      "app": "1.0.0",
      "lib": ">=1.0.0"
    },
    "locked": {
      "lib": "1.2.0"
    },
    "update": {
      "lib": "^2.0.0"
    }
  }'
```

成功时返回 `200`：

```json
{
  "satisfiable": true,
  "plan": [
    { "package": "app", "version": "1.0.0" },
    { "package": "lib", "version": "2.1.0" }
  ],
  "kept": [],
  "changed": [
    { "package": "app", "from": null, "to": "1.0.0" },
    { "package": "lib", "from": "1.2.0", "to": "2.1.0" }
  ]
}
```

- `kept`：相对 `locked` 未变化的包，按包名字典序。
- `changed`：新增（`from: null`）、删除（`to: null`）与换版（`from`/`to` 均非空）的包，按包名字典序。
- 无解时返回 `409 Conflict`，结构与 `/resolve` 相同；由 `update` 引入的约束在冲突链中标记为 `{ "type": "update" }`。
- `locked` 中的版本或 `update` 中的范围非法时返回 `400 Bad Request`。

## 解析与稳定性规则

1. 待解析包按包名字典序选择。
2. 候选版本按 semver 由高到低尝试。
3. 选定版本后，将其依赖加入约束集合，并继续深度优先搜索。
4. 当前分支失败时按上述顺序回溯。
5. 所有输出数组均显式排序：
   - 安装计划按包名字典序。
   - 冲突链中的版本列表按版本由高到低。
   - 冲突点的约束列表按范围及来源稳定排序。
6. 解析器不使用对象键顺序或时间戳作为决策依据；相同输入始终产生相同结果和数组顺序。

依赖环不会导致无限递归：已经选定的包不会再次进入待解析集合。

## 冲突响应

不存在满足全部约束的安装计划时返回 `409 Conflict`。`conflict.chain` 从根依赖开始，沿搜索过程中首个无候选包的引入路径展开，并列出：

- 每个沿途包已选定的版本；
- 该节点收到的 semver 约束；
- 约束来源（`root`、`update` 或哪个包版本引入）；
- 无候选包收到的全部约束；
- registry 中可用版本、满足全部约束的版本列表和机器可读原因码。

示例：

```json
{
  "satisfiable": false,
  "conflict": {
    "package": "lib",
    "reasonCode": "NO_VERSION_SATISFIES_CONSTRAINTS",
    "chain": [
      {
        "package": "app",
        "selectedVersion": "1.0.0",
        "requiredRange": "1.0.0",
        "requiredBy": { "type": "root" }
      },
      {
        "package": "lib",
        "requiredRange": "^2.0.0",
        "requiredBy": {
          "type": "dependency",
          "package": "app",
          "version": "1.0.0"
        },
        "constraints": [
          {
            "requiredRange": "^2.0.0",
            "requiredBy": {
              "type": "dependency",
              "package": "app",
              "version": "1.0.0"
            }
          }
        ],
        "availableVersions": ["1.0.0"],
        "compatibleVersions": [],
        "reasonCode": "NO_VERSION_SATISFIES_CONSTRAINTS"
      }
    ]
  }
}
```

原因码：

- `PACKAGE_NOT_IN_REGISTRY`：约束中的包不存在于离线 registry。
- `NO_VERSION_SATISFIES_CONSTRAINTS`：包存在，但没有版本同时满足全部约束。
- `SELECTED_VERSION_DOES_NOT_SATISFY_CONSTRAINT`：新依赖约束与当前分支已选定版本冲突；该分支随后回溯。

非法 JSON、无效 semver、错误的数据类型返回 `400 Bad Request`。

## 本地开发

要求 Node.js 20+。

```bash
npm install
npm test
npm start
```

非容器方式默认同样监听 `http://localhost:3000`。

# 流动法律服务转介的凭据领取和收窄的演练来源

这里提供独立来源的本地合成记录，与实际单位、个人和线上业务无关。

## 本地运行

使用 Node.js 22.23.4。只使用 Node.js 自带的运行库。

执行 `npm test` 检查合成来源的接口。执行 `npm start` 启动来源，默认监听 `127.0.0.1:4100`，可通过环境变量 `PORT` 调整端口。访问根路径可看到来源名和当前回放阶段。

## 接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/train` | consult 来源于咨询单编号。item scope 为通知或材料。翻译条目通过 original 指定原件。 |
| `/source/referrals` | grant 只办所列接收处、purpose 和 item，valid 为本地展开的有效区间。 |
| `/source/receiver` | received、denied 和 stopped 分别是领取确认、拒收、停止使用确认。回执保留 sourceReceipt。 |

查询参数 `offset` 是从零开始的页偏移，`limit` 默认 3，取值 1 至 100。响应中的 `records` 含 `record` 来源记录键、`availableFrom` 首次出现的回放阶段、`kind` 记录类型、`payload` 业务字段。来源记录键与业务身份分别定义。`next` 为下一页偏移，末页为 `null`。回放阶段中的记录按到达顺序可查。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段，服务会保留更早已可查的记录。每次换阶段后按根路径返回的 `stage` 确认切换成功。

## 办公室台账（采集端）

`src/` 下是采集上述来源并认定授权状态的台账系统，同样只使用 Node.js 自带运行库。执行 `npm run start:office` 启动，默认监听 `127.0.0.1:4200`，来源地址由环境变量 `SOURCE_URL` 指定（默认 `http://127.0.0.1:4100`）。`npm test` 同时检查来源接口与台账规则。

### 落账规则

- 咨询单、转介、回执全部按**咨询编号**归集；翻译记录按编号与明确的原件归属（`original`）挂接，编号未匹配的翻译进入待匹配队列，**绝不按姓名相似并案**。
- 咨询单分可通知事项与材料条目；通知事项可见但不可领取。
- 预约只证明接手窗口，不具有材料授权效力；领取只依据授权（接收点 + 用途 + 材料条目 + 起止时段四者同时限定）。
- 翻译补到后，译件也只在其授权范围内、到达时刻之后才可领取。
- 改派只改预约；原接收点的收件许可不随预约迁移，新接收点须凭自有授权领取。原接收点其他用途的授权不受影响。
- 收窄（`restrict.items` 为收窄后保留清单）不溯及既往：收窄前已合规领取的条目生成**停止使用事项**并跟踪确认；尚未领取的越权条目立即不可领。收窄与改派在同一轮采集中相遇时同样适用。
- 领取确认（`received`）与停止使用回执（`stopped`）是两类回执，互不代替；拒收（`denied`）的条目不认定为已交。
- 离线包重传按来源记录键与 `sourceReceipt` 两级去重；回执按自身时点认定，晚到不改变结论；收窄前领取、收窄后到达的回执会补发停用事项。未生效的回执不会把材料标为已交，且可在 `/office/invalid-receipts` 查看原因。

### 台账接口

| 路由 | 说明 |
| --- | --- |
| `POST /ingest` | 从来源全量采集一轮（幂等，可随回放阶段反复调用） |
| `GET /office/summary` | 台账计数：咨询、授权、回执、停用事项 |
| `GET /office/pending-stop-use` | 停用回执未到的事项：哪一次授予、哪条资料、哪个接收点 |
| `GET /office/invalid-receipts` | 未生效回执及原因、回执冲突 |
| `GET /office/unmatched-translations` | 咨询编号未匹配的翻译记录 |
| `GET /office/consults/:consult` | 单咨询全览：条目、授权、预约轨迹、回执、已交认定、停用事项 |
| `GET /office/appointments/:appointment` | 预约当前接手点与改派历史 |
| `GET /points/:point/consults/:consult/items?at=HH:MM` | 接收点视图：仅其有效授权范围内的条目，范围外不可得知 |
| `GET /points/:point/collectible?consult=..&at=HH:MM` | 接收点当前可领取的材料条目 |

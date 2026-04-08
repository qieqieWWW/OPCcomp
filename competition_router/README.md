# OPCcomp Competition Router (Initial Migration)

本项目是从现有研究方案中迁移出的初版动态路由骨架，仅位于 `OPCcomp/competition_router` 下，不影响主工程。

## 目标能力（初版）
- 小模型路由：轻量复杂度评分 + Tier 判定
- 信息池检索：从本地知识池召回 grounding 信息
- LLM Blender：PairRank + Rule-based Fuser
- V2 服务调用：兼容 `POST /apis/ais-v2/chat/completions`

## 项目结构
- `config/experts.json`: 专家池配置
- `config/info_pool.json`: 信息池（知识记录）
- `src/opc_router/small_model.py`: 小模型评分路由
- `src/opc_router/info_pool.py`: 信息池检索
- `src/opc_router/blender.py`: 排序融合
- `src/opc_router/router.py`: 专家选择
- `src/opc_router/service_client.py`: V2 接口客户端
- `src/opc_router/pipeline.py`: 动态路由流水线
- `examples/demo_run.py`: 端到端演示

## 快速运行
在仓库根目录执行：

```bash
PYTHONPATH=OPCcomp/competition_router/src python OPCcomp/competition_router/examples/demo_run.py --text "跨境医疗SaaS项目，资金压力较大，且暂无技术团队。"
```

## 使用 DeepSeek 先联调（推荐当前阶段）
1. 复制配置模板：

```bash
cp OPCcomp/competition_router/.env.example OPCcomp/competition_router/.env
```

2. 编辑 [OPCcomp/competition_router/.env](OPCcomp/competition_router/.env)，至少填写：

```env
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=你的deepseek_api_key
```

3. 运行联调：

```bash
PYTHONPATH=OPCcomp/competition_router/src python OPCcomp/competition_router/examples/demo_run.py \
  --text "请给出该项目的风险与动作建议" \
  --try-remote-llm
```

说明：
- `--provider` 可选 `deepseek` 或 `qianfan`，不传时读取 `.env` 的 `LLM_PROVIDER`。
- DeepSeek 使用 OpenAI 兼容接口（默认 `https://api.deepseek.com/chat/completions`）。
- 后续切回赛事千帆时，只需把 `.env` 改为 `LLM_PROVIDER=qianfan` 并填写 `QIANFAN_*`。

## 本地结构化看板 UI
如果你想把 JSON 结果做成图形化结构看板，直接启动这个内置页面：

```bash
cd OPCcomp/competition_router
python ui/dashboard.py --port 8501
```

打开浏览器访问：`http://127.0.0.1:8501`

看板会展示：
- 小模型评分与 tier
- 选中专家
- 信息池命中
- 候选排序
- 融合结果
- 可选远程摘要

页面左侧可以直接切换 `deepseek` / `qianfan`，并填写对应 `API Key`，方便你们组员查看同一套结构化输出。

## 远程服务调用测试（V2）
```bash
PYTHONPATH=OPCcomp/competition_router/src python OPCcomp/competition_router/examples/demo_run.py \
  --provider qianfan \
  --text "请给出该项目的风险与动作建议" \
  --host http://10.7.88.150:8080 \
  --model test \
  --api-key "<your-api-key>" \
  --try-remote-llm
```

说明：
- 若不传 `--api-key` 且服务开启鉴权，会返回 401。
- 当前实现先输出本地路由与融合结果，再可选调用远程服务做二次摘要。

## 启动 OPC 路由服务（供 openclaw-runtime 调用）
当你要跑「飞书 -> runtime -> 小模型路由 -> 多 agent 执行 -> 飞书回复」真实链路时，需要启动这个服务：

```bash
PYTHONPATH=OPCcomp/competition_router/src python OPCcomp/competition_router/examples/opc_service.py --host 0.0.0.0 --port 18080
```

健康检查：

```bash
curl http://127.0.0.1:18080/health
```

路由接口：
- `POST /route`
- 入参：`{"input":"用户任务文本","try_remote_llm":true}`
- 返回：`small_model / selected_experts / collaboration_plan / info_pool_hits / output_attribution / runtime_trace`

## 真实全链路最小启动顺序
1. 启动 OPC 路由服务（本目录 `examples/opc_service.py`）。
2. 在 `OPCcomp/openclaw-runtime` 启动技能服务：`npm run skill-service`。
3. 启动 runtime execute：`npm run runtime-execute`。
4. 启动飞书长连接：`npm run feishu-long`。

如果 OPC 路由服务未启动，飞书会收到提示：`请先启动OPC服务（competition_router）后再试。`

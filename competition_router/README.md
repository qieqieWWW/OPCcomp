# OPC Competition Router (Initial Migration)

本项目是从现有研究方案中迁移出的初版动态路由骨架，仅位于 `OPC/competition_router` 下，不影响主工程。

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
PYTHONPATH=OPC/competition_router/src python OPC/competition_router/examples/demo_run.py --text "跨境医疗SaaS项目，资金压力较大，且暂无技术团队。"
```

## 远程服务调用测试（V2）
```bash
PYTHONPATH=OPC/competition_router/src python OPC/competition_router/examples/demo_run.py \
  --text "请给出该项目的风险与动作建议" \
  --host http://10.7.88.150:8080 \
  --model test \
  --api-key "<your-api-key>" \
  --try-remote-llm
```

说明：
- 若不传 `--api-key` 且服务开启鉴权，会返回 401。
- 当前实现先输出本地路由与融合结果，再可选调用远程服务做二次摘要。

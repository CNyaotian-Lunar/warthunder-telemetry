# examples\demo —— 可复现的最小夹具

这里的 `demo\` 是一份**合成**的采集数据（不是真实战斗），用途是让人 clone 下来就能验证三个脚本：

```bash
node wt-report.mjs  examples/demo    # -> report.md + sitrep.svg
node wt-track.mjs   examples/demo    # -> track.md  + track.svg
node wt-heatmap.mjs examples/demo    # -> heatmap.md + heatmap.svg
```

夹具内容（都很小，共 ~380 KB）：

| 文件 | 说明 |
|---|---|
| `flight.jsonl` | 30 条遥测（1 Hz，含 TAS/IAS/M/高度/过载/油量/油门/AoA） |
| `objects.jsonl` | 2 帧战场态势（每帧 4 架，含一架 `icon:"Player"`） |
| `events.jsonl` | 3 条战斗日志（`kind: "evt"` / `"dmg"`） |
| `marks.jsonl` | 分段标记（`round_start` / `end`） |
| `meta.json` | 采集元信息（机型/参数/结束原因） |
| `map.img` | 地图底图 JPEG（SVG 态势图引用它） |

> ⚠️ 真实采集数据（`runs\`）体积很大且含本机路径，**不入库**；想看真实产物的样子，跑一次采集即可。
> ⚠️ 由于 `examples\demo\map.img` 需要入库，`.gitignore` 里对它做了 `!examples/**/*.img` 例外。
# sky-server SSD＋NAS 監控部署驗收（2026-11-16）

網站已部署，備份可靠性仍未完成。本次沒有執行備份、還原、容量修復、
Restic、DB 操作或新 health sample，也沒有建立 agent/thread/task/observer。

## 正式來源與實作

- 真 heartbeat 發送端：root `/usr/local/sbin/nas-backup run`，只有全工作
  成功才呼叫既有 `nas-backup-sky-server` endpoint。producer 未修改。
- 正式 Dokploy `service.env` 只修改這一筆 heartbeat：604800 秒週期＋
  129600 秒 grace＝734400 秒／204 小時截止。其他設定鍵與其他主機
  heartbeat 逐項比對相同。HermesMint、CCLabWSL、Mac mini 仍為每日＋6h。
- root 日曆仍為週日 05:00、USER 週日 04:30 Asia/Taipei，各保留 0–10min
  jitter。本次只讀原 systemd 設定，沒有重新部署備份設定。
- 正式 reporter 入口仍是原 user timer →
  `/home/sky/Projects/status.skyhong.tw/agent/skyserver_agent.py`。乾淨的原
  checkout 已 fast-forward 至 `f22e150`；沒有增加排程或手動啟動 reporter。
- reporter 沿用原 host-observer HTTP 請求，從同一 response 的安全 allowlist
  顯示 `backup_reliability`，503 持續失敗。HTTP 200 的無效／過期 metadata
  也不能變綠。
- ROOT 健康直接讀原小時健康檔 `observer-reliability.json` 及配對的
  `backup-cadence-latest.json`。schema／boolean、時間、weekly／source-a-nas／
  204h／36h／B 排除政策全驗；兩檔必須同次發佈且不超過 2h。原讀回、
  DB 還原、歷史與容量 checks 全保留；不發布原始 receipts 或私有錯誤。
- USER 只讀最新既有 manifest metadata。執行未完成、失敗、未知、缺資料、
  過期均為失敗；目前 tag-only NAS receipt 即使 fresh 也不等於 root
  A `/backup`＋NAS `ServiceBackups` 整合成功，維持未驗證。
- B 明列 excluded／not a backup；legacy isolation policy 不會被稱為 B
  資料完整性成功。完全沒有 B device access／mount／probe／read。
- `/api/incidents` 將受限制的備份與 host-observer 事件放進 `reportOnly`，
  排除舊 Hermes 消費的 `active` 自動修復佇列；保留 confirmed、告警、
  failingSince 與 history。策略明列禁止未經原 backup workflow gate 的修復。

## 測試與部署

- `npm test`：65/65 通過；測試 preload 禁止真網路／DNS／child command。
- `python3 -B agent/run_local_tests.py`：82 項，78 通過、4 個原有 integration
  tests 依既定 guarded runner 跳過。新增測試包含每個 canonical failure、
  過期／未來／未知／無效／不配對 metadata、USER partial／failure／fresh
  legacy receipt、observer 安全摘要，以及 204h 邊界與其他主機設定不變。
- Node syntax check 與 `git diff --check` 通過。
- 網站 image：`blog-svc-status:83ab5d6`；build commit
  `83ab5d6532cac225b3597ccb155274cd68b39c7b`。其後 reporter-only 修正部署為
  `f22e150`，不需重建網站。未開／推 PR。
- 沿用正式 Dokploy Compose project `compose-back-up-mobile-sensor-r6ux44`，
  只更新網站 image 並 `up -d --no-deps status-dashboard`。原 labels、networks、
  Docker proxy、認證及 `/srv/status-dashboard/data:/data` 保留。
- `/readyz` production 實測 HTTP 200、`ok:true`、`version:83ab5d6`；容器
  `healthy`；log rotation 仍 20m ×3。網站切換時 reporter 一次 HTTP 502，
  原 timer 後續自然回報 exit 0，沒有補造 heartbeat。

## Production API 與 UI 實測

2026-11-16 01:05 台北，真 production browser 讀取 API 並重新載入正式頁面：

- sky-server heartbeat：`periodSeconds:604800`、`graceSeconds:129600`、
  `deadlineSeconds:734400`、`successOnly:true`。舊 last ping 未變；依新政策
  時效內，UI 明列「每 7 天」「截止 204 小時，非 RPO 保證」。
- ROOT monitor：`up:false`，`incomplete: capture, history, capacity`；B excluded。
- USER monitor：`up:false`，`run incomplete; A+NAS integration unverified`。
- host-observer：`up:false`，`HTTP 503 · backup_reliability, legacy receipt
  freshness (30h)`，沒有以 weekly heartbeat 放寬而掩蓋。
- 以上三項進入 `reportOnly`，`automaticRemediationAllowed:false`；自動修復
  `active` 沒有這些備份項目。所有異常仍在 UI 顯示故障，總體仍為部分服務中斷。
- 桌面 1280px 與手機 390px 的真 DOM 文字核對通過；手機無水平溢出。

## 保留與限制

部署前私有設定、200 筆既有事件及核對基準保存在 root-only 的
`/srv/status-dashboard/deployments/weekly-monitoring-20261116/`。沒有手動刪除、
reset 或覆寫舊 failure；正常告警／recovery 仍依既有 200 筆 rolling policy
寫入，輪替出去的部署前事件仍完整留在該私有基準，不發布其內容。

核對 root success ping 原值相同、三份 workspace 權威文件與 root RUNBOOK
SHA 相同，maintenance PID／invocation／MemoryHigh 320MiB／MemoryMax 384MiB／
SwapMax 0 相同。沒有改 livingdocs／manifest／producer／waiters／DB／NAS secret。

原 00:36 實審的 NAS 完整讀回未完、有效 consumer stream 0、A 約 43.37GiB
低於 64GiB admission、最新完整輪與單 artifact 整合未成，仍是權威未完成
狀態；本 thread 沒有另採樣或宣稱修復。01:00 原 hourly health 自然更新後
才讀取既有 metadata，仍為 capture／history／capacity 未通過。

仍有界線：上游 observer 的舊 per-job receipt freshness 仍為 30h；本次
只標明 legacy，沒有越出 status／reporter 範圍修改或重啟 observer。它不
取代已校正的 canonical weekly health。新自然完整 A＋NAS 輪、USER 整合、
資料讀回／DB 還原／容量是否真正成功，由原備份 workflow 驗證；本次網站
部署不證明那些項目完成。外部 Hermes 的私有執行器沒有在本次測試中運行；
已驗證 status API 的自動修復入口隔離，其他機器權限未變更。

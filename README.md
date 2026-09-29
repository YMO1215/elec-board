# elec-board — 전기 업무 보드

4인 전기 업무팀을 위한 웹앱입니다. 현장 단위로 업무·점검·지적·보고서를 묶고,
**4열 자석 업무 보드**, **모바일 점검 체크리스트(오프라인)**, **KPI 자동 계산**,
**전기 법령·KEC·KS 원문 링크**를 한 화면 구조(PC 사이드바 / 모바일 하단 탭)에서 다룹니다.

- 백엔드: Python 3.12 · FastAPI · SQLite(WAL) · reportlab(PDF) · segno(QR)
- 프론트엔드: 빌드 없는 ES 모듈 + PWA(서비스 워커, IndexedDB 오프라인 큐)
- 기본 포트: `8810`

## 빠른 시작 (Windows PowerShell)

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt

# 둘 중 하나
.\.venv\Scripts\python.exe -m app.cli demo                     # 데모 팀·현장·업무·점검까지 생성
.\.venv\Scripts\python.exe -m app.cli init --org "전기팀" --name "홍길동" --email admin@example.com

.\.venv\Scripts\python.exe -m app.cli serve --port 8810         # http://127.0.0.1:8810
```

`init`/`demo` 없이 서버를 띄우면 첫 화면이 **처음 설정**(팀 + 첫 관리자) 화면입니다.
서버가 외부에 열려 있다면 `ELEC_SETUP_TOKEN` 을 지정해 두세요.

데모 계정(비밀번호 `demo-pass-1234`):

| 보드 열 | 이름 | 이메일 | 역할 |
|---|---|---|---|
| 1 | 김관리 | admin@demo.local | 관리자·작업자 |
| 2 | 이현장 | field1@demo.local | 작업자 |
| 3 | 박검토 | reviewer@demo.local | 검토자·작업자 |
| 4 | 최설비 | field2@demo.local | 작업자 |

## 테스트

```powershell
.\.venv\Scripts\python.exe -m pytest -q     # API·권한·무결성·KPI·조직 격리 (45개)
node --test tests/js/                        # 보드 투영·날짜/퍼센트 포맷 (11개)
node scripts/check-web.js                    # 모듈 구문·import 연결·금지 패턴(select/alert/inline style)
```

## 구조

```
app/
  main.py            앱 팩토리, 보안 헤더(CSP), 정적 파일
  schema.sql         스키마 + append-only 트리거
  config.py db.py    환경변수, SQLite 연결(BEGIN IMMEDIATE 쓰기 트랜잭션)
  security.py        scrypt 비밀번호, 토큰 해시, 서명된 파일 URL
  audit.py           조직별 해시 체인 감사 로그
  api/               auth · work(현장·업무·보드) · field(설비·점검·첨부·지적·보고서) · insight(KPI·법령·대시보드·동기화)
  services/          도메인 로직 (tasks · inspections · kpi · knowledge · org · files · pdf · team)
  cli.py demo.py     init / demo / serve / verify-audit
web/
  index.html sw.js manifest.webmanifest css/app.css
  js/app.js router.js api.js store.js ui.js dom.js
  js/lib/            순수 로직 (board-model, format) — 단위 테스트 대상
  js/offline/        IndexedDB 초안·첨부 저장, 동기화 큐
  js/views/          dashboard · board · task-sheet · inspect · inspect-run · inspection-detail · kpi · knowledge · site · settings · auth
tests/               pytest + tests/js (node:test)
```

## 지시서 대응

| 지시서 항목 | 구현 |
|---|---|
| 메뉴 5개 고정, PC 사이드바 / 모바일 하단 탭 | `web/index.html` 셸, 720px 한 경계. 설정은 사이드바 하단·상단바 아이콘(메뉴 5개 밖) |
| 4열 자석 보드, 담당자별/상태별 토글 | `views/board.js` + `lib/board-model.js`. 같은 업무 목록의 두 투영, 토글해도 필터·현장·스크롤 유지 |
| 담당자별 이동 = 주 담당자만, 상태별 이동 = 상태만 | `PATCH /api/tasks/:id/assignee`, `PATCH /api/tasks/:id/status` 별도 명령, 둘 다 `task_events` 에 이전값·새값·이동자·시각 기록 |
| 카드 1장 = 현재 보기의 한 열 | 주 담당자는 **보드 열(1~4)이 있는 활성 팀원만** 가능(서버 검사). 협업자는 열 배정에 포함 안 됨 |
| 열 건수 = 대시보드 숫자 | 둘 다 `GET /api/tasks/board-summary` 한 응답. 클라이언트 재계산 없음. 담당자별 합 = 상태별 합 = 전체(테스트) |
| 담당자 색 자석 + 이름/이니셜 | 4색은 색각 이상 시뮬레이션·대비 검증을 통과한 세트(파일 머리 주석). 상태색(앰버/레드/그린)과 겹치지 않음 |
| PC 드래그 → 살짝 분리 → 스냅 | 포인터 드래그, 120ms 들림 + 150ms 스냅, `prefers-reduced-motion` 이면 애니메이션 생략 |
| 저장 실패 시 원위치 + 이유 + 재시도 | 낙관적 이동 후 실패하면 원래 열·순서로 복구, 배너에 이유와 [재시도]. 동시 수정은 `version` 으로 409 |
| 모바일: 탭 → 이동 → 대상 → 확정 / 키보드 | 카드 탭(또는 Enter) → 시트의 [이동] → 4개 대상 → [확정]. 카드에서 `M` 키로 바로 이동 메뉴 |
| QR / 목록 → 체크리스트 | 설비 QR = `<앱 주소>#/q/<무작위 토큰>` → 휴대폰 기본 카메라로 바로 열림. 지원 브라우저는 앱 안 스캐너(BarcodeDetector)도 제공 |
| 양호/불량/해당없음, 메모, 사진·영상, GPS, 전자서명 | `views/inspect-run.js`. 판정 버튼 64px, 불량이면 메모 필수 |
| 오프라인 큐, append-only, 정정은 새 기록 | 모든 입력은 기기(IndexedDB)에 먼저 저장 → 제출 시 큐. 초안 생성·첨부·제출 모두 멱등 키. 제출 후 원본은 DB 트리거로 수정·삭제 불가, 정정본은 `corrects_id` 로 연결 |
| 동기화 충돌 시 비교·선택 | 서버 초안 `draft_version` 비교 → 409 + 서버본 → 화면에서 항목별 비교 후 "이 기기 유지 / 서버본 사용" |
| 검토 → 승인 → PDF | 검토자 통과(자기 점검 검토 금지) → 보고서 승인 요청 → 관리자 승인 시 서버에서 PDF 생성(버전·생성시각·승인자·원본 해시 포함) |
| 불량 → 지적사항 + 후속 업무 | 제출 시 불량 항목마다 지적 + `finding` 업무 자동 생성, 담당자·기한 지정 가능 |
| KPI 4종 + 가중평균, 정의·분자/분모·기준시각·좋은 방향 | `services/kpi.py`. 분모 0 → `—`(0% 아님). 드릴다운 목록이 같은 행 목록에서 나옴(테스트) |
| 법령·규격: 출처·확인일·요약·원문 링크, 오래된 항목 표시 | 전문 미저장. 검토 기한이 지나면 "검토 필요". 법률 자문 아님 고지. 기본 9개 항목(2026-09-29 링크 응답 확인) |
| 실제 인증·DB·파일 저장소·권한·감사 로그·PDF·테스트 | 세션 쿠키(HttpOnly, SameSite=Lax) + CSRF 헤더, 조직 단위 행 필터, 비공개 저장소 + 만료 서명 URL, 해시 체인 감사 로그, 가짜 저장 없음 |

## API (지시서 경로 → 실제 경로)

모든 API 는 `/api` 아래입니다. 전체 명세는 서버 실행 후 `/api/docs`.

| 지시서 | 실제 |
|---|---|
| `POST /auth/invite` | `POST /api/auth/invite` (+ `GET/POST /api/auth/invite/{token}[/accept]`) |
| `GET/POST /sites` | `GET/POST /api/sites` |
| `GET /sites/:id/tasks`, `POST /tasks` | `GET /api/sites/{id}/tasks`, `POST /api/tasks` |
| `PATCH /tasks/:id/assignee`, `PATCH /tasks/:id/status` | 동일 (`/api` 접두) |
| `POST /tasks/:id/check-items`, `GET /tasks/board-summary` | 동일 (`/api` 접두) |
| `GET /assets/by-qr/:token` | 동일 (`/api` 접두) |
| `POST /inspections/drafts`, `POST /inspections/:id/submit` | 동일 (`/api` 접두) |
| `POST /inspections/:id/review`, `POST /inspections/:id/corrections` | 동일 (`/api` 접두) |
| `POST /reports/:id/approve`, `GET /reports/:id/pdf` | 동일 (`/api` 접두) |
| `GET /kpi/summary`, `GET /kpi/drilldown` | 동일 (`/api` 접두) |
| `GET /knowledge`, `GET /knowledge/:id` | 동일 (`/api` 접두) |

## 권한

| 역할 | 할 수 있는 일 | 막힌 일 |
|---|---|---|
| 관리자 | 초대·비활성화, 역할·보드 열 배정, 현장·설비·서식, KPI 목표·가중치, 보고서 승인, 법령 항목 관리, 모든 업무 이동 | 제출된 점검 원본 수정·삭제(DB 트리거) |
| 작업자 | 업무 생성·수정, **자기 담당** 업무의 상태 변경·인계, 점검 작성·제출, 지적 조치 등록(자기 담당) | 타인 업무 이동, 승인, 팀 설정 |
| 검토자 | 전체 열람, 제출 점검 검토·반려(항목별 의견), 승인 요청 | 자기 점검 검토, 관리자 설정 |

한 사람이 역할을 겸할 수 있고, 모든 검사는 서버에서 합니다. 다른 조직의 데이터는 404로만 보입니다.

## KPI 산식

| 지표 | 분자 ÷ 분모 | 기간 기준 |
|---|---|---|
| 점검 완료율 | 점검 기록이 제출된 점검 업무 ÷ 기한이 기간 안인 점검 업무 | 업무 마감일 |
| 정시 완료율 | 기한 내 완료 업무 ÷ 기간 안에 완료된 업무(기한 있는 것만) | 완료 시각 |
| 지적 조치율 | 조치 완료 지적 ÷ 기간 안에 발견된 지적 | 발견 시각 |
| 보고서 승인율 | 승인 보고서 ÷ 기간 안에 제출(승인 요청)된 보고서 | 요청 시각 |

- 가중평균 = Σ(달성률 × 가중치) ÷ Σ(가중치). 달성률 = 값 ÷ 목표 × 100, 상한 100%. 데이터 없는 지표는 양쪽 합에서 제외.
- 가중치 합은 100이어야 저장되고, 변경은 감사 로그와 설정 화면 이력에 남습니다.
- 비교 기준은 **직전 동일 기간**, 목표는 **관리자 설정 목표**로 화면에 명시합니다.
- 관리자는 기간 KPI를 "마감 기록"(`kpi_snapshots`)으로 고정할 수 있습니다.

## 데이터 무결성

- 제출된 `inspections`/`inspection_items`, 검토 이력, 결정된 보고서, 증빙 첨부, `task_events`, `audit_logs` 는
  SQLite 트리거로 UPDATE/DELETE 가 막혀 있습니다(API 를 우회한 SQL 도 실패).
- 제출 시 내용 전체(증빙 파일 SHA-256 포함)의 해시를 저장하고, 상세 화면의 [무결성 확인]으로 재계산해 비교합니다.
- 감사 로그는 조직별 해시 체인입니다: `python -m app.cli verify-audit`.

## 환경 변수

`.env.example` 참고. 핵심: `ELEC_DATA_DIR`(DB·첨부·PDF 위치 — 백업 대상), `ELEC_SECRET_KEY`, `ELEC_SETUP_TOKEN`,
`ELEC_COOKIE_SECURE`(HTTPS 뒤에서 true), `ELEC_PDF_FONT`.

## 지시서 11장 — 이번 구현에서 정한 기본값과 남은 결정

| 항목 | 이번 기본값 | 확정이 필요한 것 |
|---|---|---|
| 배포·계정 | 단일 서버 + SQLite + 로컬 비공개 파일 저장소. 초대는 **1회용 링크(7일)** 를 관리자가 직접 전달(메일 발송 없음). 비활성화 시 담당 업무·지적을 다른 팀원에게 넘기고 세션 즉시 폐기 | 호스팅 위치(사내 서버/게이트웨이 등록 여부), HTTPS, 메일 발송 여부. Vercel 서버리스는 SQLite·로컬 파일 저장과 맞지 않아 쓰려면 Postgres·객체 저장소로 바꿔야 함 |
| 점검 서식 | **예시 서식 4종**(분전반·수변전·접지·비상발전기) — 화면·PDF에 "예시 서식" 표시 | 실제 설비 유형, 법정 서식, 필수 증빙, 보관 기간(현장별 기본 4년) |
| KPI 목표·가중치 | 목표 95/90/90/95%, 가중치 30/30/20/20 | 지표별 목표, 평가 기간, 개인·팀 반영 비율 |
| 법령 갱신 | 확인 후 180일이 지나면 "검토 필요", 관리자가 [확인 완료]로 갱신 | 검토 담당자·주기, 변경 감지 방법 |

- 한국전기공사협회 링크는 공식 주소 확인 전이라 넣지 않았습니다(지시서 주의사항).
- KEC 포털(`kec.kea.kr`)은 2026-09-29 응답을 확인했고, 페이지 제목의 운영 기관명이 지시서 표기(대한전기협회)와 달라
  출처 이름을 "전기설비기술기준 포털(kec.kea.kr)"로 적었습니다.

## 알려진 제한

- 앱 안 QR 스캐너는 BarcodeDetector 지원 브라우저(안드로이드 크롬 등)에서만 보입니다. 아이폰은 기본 카메라로 QR 을 비추면 됩니다.
- 사용자 1명은 1개 조직에만 속합니다.
- 실시간 반영은 15초 간격 변경 감지(조직 `rev`) 폴링입니다.
- 음성 메모·자동 일정 생성·고급 분석(지시서 P2)은 포함하지 않았습니다.

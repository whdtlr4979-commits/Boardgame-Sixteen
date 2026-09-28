# Sixteen · 온라인 식스틴

보드게임 **식스틴(Sixteen)** 을 친구들과 실시간으로 즐길 수 있는 온라인 멀티플레이 웹사이트입니다.
UI는 **Instagram** 디자인 언어(좌측 내비게이션, 스토리 링, 피드 카드, DM 스타일 채팅, 라이트/다크 모드)를 참고했습니다.

직접 운영하는 서버 없이 **Supabase**(데이터베이스 + Realtime + Edge Function)와 정적 호스팅(GitHub Pages 등)만으로 동작합니다.

## 주요 기능

- 🔴 **실시간 멀티플레이** — Supabase Realtime, 2~4인
- 🏠 **로비 피드** — 열린 방이 인스타그램 게시물처럼 표시, 접속자는 스토리 링으로 표시(Presence)
- 🔗 **초대 코드 / 초대 링크** — `?room=CODE` 링크로 바로 입장
- 🤖 **AI 봇** — 빈 자리를 봇으로 채우거나 "봇과 바로 한 판"으로 즉시 연습
- 💬 **DM 스타일 채팅** + 게임 기록 + 점수표
- 🔄 **재접속 지원** — 새로고침해도 자리 유지, 게임 중 나가면 봇이 대신 플레이하고 다시 들어오면 자리를 되찾음
- ⏱️ **응답 없는 플레이어 대체** — 차례인 사람이 60초 이상 응답이 없으면 다른 사람이 봇으로 대체 가능
- 🙈 **가림막(치팅 방지)** — 각자 자기 손패만 읽을 수 있고(RLS), 모든 수는 Edge Function에서 검증
- 📱 반응형(데스크톱 / 태블릿 / 모바일 하단 탭바), 다크 모드, 키보드 단축키(Enter 내려놓기, P 패스, Esc 선택 해제)

## 구조

```
브라우저 (public/, 정적 파일)
  ├─ 읽기:  Supabase DB 직접 조회 + Realtime 구독 (rooms, games, 내 hands, messages)
  ├─ 접속자: Realtime Presence
  └─ 쓰기:  Edge Function `sixteen` 호출 (방 만들기, 타일 내기, 채팅 …)
                 │
Supabase         ▼
  ├─ Edge Function (supabase/functions/sixteen) — 규칙 검증, 봇 진행
  ├─ Postgres (supabase/migrations) — 테이블, RLS, 원자적 저장 함수
  └─ Auth — 익명 로그인 (가입 없이 닉네임만으로 플레이)
```

| 테이블 | 내용 | 누가 읽나 |
| --- | --- | --- |
| `rooms` | 방 정보, 멤버 목록 | 모두 |
| `games` | 공개 게임 상태 (테이블 위 타일, 남은 타일 수, 점수, 기록) | 모두 |
| `hands` | 플레이어별 손패 | **본인만** |
| `game_secrets` | 전체 게임 상태 (모든 손패, 뽑기 더미) | 아무도 (Edge Function만) |
| `messages` | 채팅/시스템 메시지 | 모두 |

브라우저는 테이블에 직접 쓸 수 없고, 모든 변경은 Edge Function이 버전 확인(낙관적 동시성 제어)과 함께 저장합니다.

```
public/                    정적 웹사이트 (HTML/CSS/JS, 빌드 불필요)
  config.js                ← Supabase URL / anon key 입력
  app.js                   화면 로직
  net.js                   Supabase 연결 (인증, Realtime, Presence, Edge Function 호출)
  game.js                  게임 엔진 (supabase/functions/_shared/game.js 복사본)
supabase/
  migrations/              DB 스키마 + RLS + Realtime 설정
  functions/sixteen/       Edge Function 진입점 (Deno)
  functions/_shared/       게임 엔진(game.js), 액션 처리(core.js)
test/                      엔진·액션 단위 테스트, Supabase E2E 테스트
.github/workflows/         CI(테스트), GitHub Pages 배포
```

## 설정 및 배포

### 1. Supabase 프로젝트 만들기
[supabase.com](https://supabase.com)에서 새 프로젝트를 만듭니다. (무료 플랜 가능)

### 2. 익명 로그인 켜기
대시보드 → **Authentication → Sign In / Providers** → **Allow anonymous sign-ins** 를 켭니다.

### 3. 데이터베이스와 Edge Function 배포
Node.js가 설치된 컴퓨터에서:

```bash
npx supabase login
npx supabase link --project-ref <프로젝트 REF>   # 대시보드 URL의 영문/숫자 ID
npx supabase db push                             # 테이블·RLS·Realtime 설정
npx supabase functions deploy sixteen --use-api  # 게임 서버 로직
```

> CLI 대신 대시보드 **SQL Editor**에 `supabase/migrations/20260928000000_sixteen.sql` 내용을 붙여넣어 실행해도 됩니다.
> (Edge Function은 CLI로 배포해야 합니다.)

### 4. 웹사이트에 연결 정보 입력
대시보드 → **Project Settings → API** 에서 **Project URL** 과 **anon (public) key** 를 복사해 `public/config.js` 에 넣습니다.

```js
window.SIXTEEN_CONFIG = {
  supabaseUrl: 'https://xxxxxxxx.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...',
};
```

anon key는 공개되어도 되는 키입니다. **service_role key는 절대 넣지 마세요.**

### 5. 웹사이트 호스팅 (GitHub Pages)
1. 위 변경을 `main` 브랜치에 커밋/푸시합니다.
2. 저장소 **Settings → Pages → Build and deployment → Source** 를 **GitHub Actions** 로 선택합니다.
3. `Deploy to GitHub Pages` 워크플로가 `public/` 폴더를 배포합니다 → `https://<사용자명>.github.io/<저장소명>/`

`public/` 폴더는 순수 정적 파일이라 Netlify, Vercel, Cloudflare Pages 등 어디에 올려도 됩니다.

### 참고
- Supabase 무료 프로젝트는 일정 기간 사용이 없으면 일시 중지될 수 있습니다(대시보드에서 다시 켤 수 있음).
- 익명 로그인은 IP당 시간당 횟수 제한이 있습니다(**Authentication → Rate Limits**에서 조정).
- 봇이 수를 두는 간격은 Edge Function 환경 변수 `BOT_DELAY_MS`(기본 900ms)로 바꿀 수 있습니다.
- 3시간 이상 활동이 없는 방은 새 방이 만들어질 때 자동으로 정리됩니다.

## 로컬 개발

Docker가 필요합니다.

```bash
npm install
npx supabase start          # 로컬 Supabase (DB, Auth, Realtime, Edge Functions)
npm run dev                 # http://localhost:5173
```

`npx supabase start` 가 출력하는 `API_URL` 과 `ANON_KEY` 를 `public/config.js` 에 넣으면 됩니다.

## 테스트

```bash
npm test                    # 게임 엔진 + 액션 처리 단위 테스트 (Supabase 불필요)

# 실제 Supabase(로컬 또는 원격)에 대한 E2E: 전체 게임 진행, Realtime, 보안 정책(RLS) 검증
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon key> npm run test:e2e
```

게임 엔진 원본은 `supabase/functions/_shared/game.js` 입니다. 수정한 뒤 `npm run sync` 로 `public/game.js` 에 복사하세요.
(두 파일이 다르면 `npm test` 가 실패합니다.)

## 게임 규칙 (공식 식스틴 규칙 기준)

| 항목 | 내용 |
| --- | --- |
| 인원 | 2~4인 |
| 구성물 | 5색(빨강·노랑·초록·파랑·보라) × (숫자 1~15 + **16 RESTART** + **16 END**) = 85개 + **가위** 2개 + **쓰레기통** 1개 = **88개** |
| 준비 | 2인 30개, 3인 29개, 4인 22개씩 배분(나머지는 미사용). **1 타일 5개를 모두 꺼내** 색깔별 줄 5개를 시작 |
| 놓기 | 같은 색 타일 1개 또는 **같은 색의 연속된 숫자 여러 개**를 그 색 줄 끝에. 줄 끝보다 **큰 숫자만**, 건너뛰기 가능 |
| RESTART | 16으로 놓이고 이후 0으로 취급 → 그 줄을 처음부터 다시 이어감 |
| END | 16으로 놓이고 그 줄을 닫음 |
| 가위 / 쓰레기통 | 원하는 줄의 마지막 타일 1개 제거 / 원하는 줄을 1만 남기고 비움 |
| 패스 | 놓을 수 있는 타일이 **없을 때만** |
| 승리 | 타일을 **먼저 모두 내려놓은 사람**. 모두 연속 패스(아무도 못 놓음)하면 **남은 숫자 합이 가장 적은 사람** |

> 확인하지 못한 세부 사항은 다음과 같이 정했습니다: 가위·쓰레기통은 남아도 벌점 0점, RESTART·END는 16점,
> END로 닫힌 줄도 가위로 END를 잘라내면 다시 열림. 규칙은 모두 `supabase/functions/_shared/game.js`에 있어
> 쉽게 조정할 수 있습니다 (수정 후 `npm run sync` 와 `npx supabase functions deploy sixteen --use-api`).

[English](README.md) | **한국어** | [日本語](README.jp.md)

# HTTPS 배포

운영 환경의 BrainVault는 반드시 HTTPS로 제공해야 합니다. 방법은 두 가지입니다.

- **직접 HTTPS**: BrainVault가 Posh-ACME로 발급한 인증서 파일을 사용해 직접 TLS를 처리합니다.
- **리버스 프록시**: Caddy, NGINX, Nginx Proxy Manager, Synology DSM이 공개 TLS를 처리하고 내부 HTTP로 BrainVault에 전달합니다.

## 목차

- [배포 방식 선택](#배포-방식-선택)
- [두 방식 공통 설정](#두-방식-공통-설정)
- [방식 A. Posh-ACME로 직접 HTTPS 제공](#방식-a-posh-acme로-직접-https-제공)
- [방식 B. 리버스 프록시를 통한 HTTPS](#방식-b-리버스-프록시를-통한-https)
- [운영 시 주의사항](#운영-시-주의사항)
- [VPN/프록시 차단](#vpn프록시-차단)
- [이 디렉터리의 파일](#이-디렉터리의-파일)

## 배포 방식 선택

| | 직접 HTTPS (`HTTPS_MODE=posh-acme`) | 리버스 프록시 (`HTTPS_MODE=proxy`) |
| --- | --- | --- |
| TLS 처리 주체 | BrainVault | 프록시 |
| BrainVault 수신 주소 | 공개 HTTPS (예: `0.0.0.0:443`) | 내부 HTTP (예: `127.0.0.1:4000`) |
| 인증서 | Posh-ACME 파일, 시작 시 로드 | 프록시가 관리 |
| HTTP→HTTPS 리디렉션 | 제공하지 않음 (80번 포트 미사용) | BrainVault 또는 프록시가 제공 |
| 진입점 요청 제한 | 애플리케이션 제한만 적용 | 프록시 제한 추가 가능 ([아래 참고](#공개-진입점-요청-제한)) |
| VPN/프록시 측정 | WebSocket만 측정 (TCP_INFO 없음) | 지원되는 진입점에서 TCP/WebSocket 전체 비교 |
| 적합한 환경 | 프록시 없는 단일 Windows 호스트 | 대부분의 배포, NAS, 컨테이너 |

잘 모르겠다면 리버스 프록시를 사용하세요.

<details>
<summary>처음이신가요? 핵심 용어</summary>

| 용어 | 뜻 |
| --- | --- |
| TLS / HTTPS | 브라우저와 서버 사이의 암호화. 도메인용 인증서가 필요합니다. |
| 리버스 프록시 | BrainVault 앞에서 공개 HTTPS 요청을 받아 BrainVault로 전달하는 웹 서버. |
| Origin | 사이트의 프로토콜, 도메인, 포트 조합. 예: `https://notes.example.com` |
| WebSocket | 실시간 협업에 쓰이는 지속 연결. 프록시가 WebSocket "업그레이드"를 허용해야 합니다. |
| Loopback | 자기 자신을 가리키는 주소(`127.0.0.1`). 같은 컴퓨터의 프로그램만 접근할 수 있습니다. |

</details>

## 두 방식 공통 설정

두 방식 모두 사이트의 공개 URL이 필요합니다. `notes.example.com`을 실제 도메인으로 바꾸세요.

```env
NODE_ENV=production

PUBLIC_ORIGIN="https://notes.example.com"
WEBAUTHN_RP_ID="notes.example.com"
WEBAUTHN_ORIGIN="https://notes.example.com"
CORS_ORIGIN="https://notes.example.com"
```

`JWT_SECRET`은 재시작해도 바뀌지 않도록 유지하세요. 이 값은 삭제 미리보기 서명에도 사용되므로, 변경하면 발급된 미리보기가 무효화되고 삭제 전에 미리보기를 다시 조회해야 합니다. 서명 방식이 도입되기 전에 만든 미리보기는 `409 PAGE_EDIT_CONFLICT`로 실패합니다.

모든 환경 변수는 [설정 가이드](../docs/configuration/2026-07-28/configuration.ko.md)를 참고하세요.

## 방식 A. Posh-ACME로 직접 HTTPS 제공

### 1. 인증서 파일 위치 확인

Posh-ACME는 인증서 order 폴더마다 `fullchain.cer`(인증서와 발급 체인)와 `cert.key`(개인 키)를 저장합니다. PowerShell에서 현재 order의 경로를 확인합니다.

```powershell
Get-PACertificate | Format-List Subject,FullChainFile,KeyFile,NotAfter
```

### 2. BrainVault 설정

[공통 설정](#두-방식-공통-설정)에 다음을 추가합니다. `POSH_ACME_CERT_PATH`에는 order 폴더 또는 위에서 확인한 `FullChainFile` 경로를 지정할 수 있습니다.

```env
HOST="0.0.0.0"
PORT=443

HTTPS_MODE=posh-acme
POSH_ACME_CERT_PATH="C:/Users/service-account/AppData/Local/Posh-ACME/acme-v02.api.letsencrypt.org/example-order/fullchain.cer"
# 선택 사항. 기본적으로 fullchain.cer 옆의 cert.key를 읽습니다.
# POSH_ACME_KEY_PATH="D:/certificates/notes.example.com/cert.key"
```

- Windows `.env` 경로에는 슬래시(`/`)를 사용해 백슬래시 이스케이프 문제를 피하세요.
- BrainVault를 실행하는 계정에 두 파일의 읽기 권한이 있어야 합니다.

### 3. 시작 및 확인

BrainVault는 시작할 때 인증서가 현재 유효한지, `PUBLIC_ORIGIN`의 호스트 이름을 포함하는지, 개인 키와 일치하는지 확인합니다. 파일이 없거나 잘못되었으면 HTTP로 대체하지 않고 시작을 중단합니다.

로그에 `Posh-ACME HTTPS mode enabled`가 표시되어야 합니다. 이어서 다음을 확인합니다.

```bash
curl -I https://notes.example.com/health
curl -I https://notes.example.com/
```

협업 WebSocket도 같은 HTTPS 리스너를 사용하므로 추가 설정이 필요 없습니다.

### 4. 인증서 갱신 후 재시작

인증서 파일은 시작할 때만 읽으므로 Posh-ACME가 인증서를 갱신하면 BrainVault를 재시작해야 합니다. 예를 들어 예약된 갱신 작업에서 다음과 같이 처리합니다.

```powershell
Set-PAOrder notes.example.com
if (Submit-Renewal) {
    Restart-Service -Name BrainVault
}
```

> [!NOTE]
> 이 방식은 `HOST`:`PORT`의 HTTPS 리스너만 엽니다. 80번 포트는 사용하지 않습니다. HTTP→HTTPS 리디렉션이 필요하면 방화벽, 공유기 또는 별도 리디렉션 서비스를 사용하세요.

## 방식 B. 리버스 프록시를 통한 HTTPS

### 1. BrainVault 설정

[공통 설정](#두-방식-공통-설정)에 다음을 추가합니다. 아래는 같은 호스트에서 프록시를 실행하는 예시입니다.

```env
HOST="127.0.0.1"
PORT=4000

HTTPS_MODE=proxy
HTTPS_REDIRECT=true
HTTPS_HEALTHCHECK_BYPASS=true
TRUST_PROXY_ADDRESSES="loopback"
TRUST_PROXY_HOPS=0
```

| 설정 | 역할 |
| --- | --- |
| `TRUST_PROXY_ADDRESSES` | 필수. 이 주소에서 온 요청만 `X-Forwarded-Proto`를 지정할 수 있습니다. 같은 호스트의 프록시는 `loopback`을 사용합니다. 다른 컨테이너나 호스트의 프록시는 정확한 IP 또는 가능한 한 좁은 CIDR을 지정하세요. 모든 주소를 허용하는 `/0` 범위는 거부됩니다. |
| `TRUST_PROXY_HOPS` | 호환성을 위해서만 남아 있으며 반드시 `0`이어야 합니다. 백엔드까지 더 짧은 경로를 가진 클라이언트가 전달 헤더를 위조할 수 있으므로 hop 수 기반 신뢰는 거부됩니다. |
| `HTTPS_REDIRECT` | `true`: 일반 HTTP 요청을 `PUBLIC_ORIGIN`으로 308 리디렉션합니다. `false`: `426 HTTPS_REQUIRED`를 반환합니다. |
| `HTTPS_HEALTHCHECK_BYPASS` | `true`: 로컬 점검을 위해 `/health`를 내부 HTTP로 계속 사용할 수 있습니다. |
| `HOST` | 프록시가 접근할 수 있는 인터페이스에만 바인딩하세요. 4000번 포트를 외부에 공개하지 마세요. |

### 2. 프록시 설정

어떤 프록시든 세 가지를 해야 합니다. 도메인의 TLS 제공, `X-Forwarded-Proto: https` 전달, WebSocket 업그레이드 허용(`/api/collaboration/`와 `/api/network-verification/probe`에서 사용)입니다.

#### Caddy

[Caddyfile.example](Caddyfile.example)을 복사해 도메인과 백엔드 주소를 바꾸고 Caddy를 다시 로드합니다. `reverse_proxy`가 원래 프로토콜을 전달하고 WebSocket 업그레이드도 자동으로 처리합니다.

#### NGINX

1. [nginx.conf.example](nginx.conf.example)의 `log_format`, `map`, `limit_req_zone` 줄과 두 `server` 블록을 `http` 컨텍스트에 복사합니다.
2. 도메인과 인증서 경로를 수정합니다.
3. `nginx -t`로 검사한 뒤 다시 로드합니다.

예시의 `Upgrade`, `Connection` 헤더는 협업에 필요합니다. 예시에는 [요청 제한](#공개-진입점-요청-제한)과 [안전한 로그 설정](#프록시-로그에-인증-정보-남기지-않기)도 포함되어 있습니다.

#### Nginx Proxy Manager

Proxy Host를 다음과 같이 만듭니다.

| 항목 | 값 |
| --- | --- |
| Domain | `notes.example.com` |
| Scheme | `http` |
| Forward host/IP | BrainVault 내부 주소 |
| Forward port | `4000` |
| Websockets Support | 사용 |
| SSL certificate | 선택 |
| Force SSL | 사용 |

Nginx Proxy Manager는 일반적으로 전달 호스트와 프로토콜 헤더를 보냅니다. 4000번 포트는 프록시 네트워크에서만 접근할 수 있게 하세요.

#### Synology DSM 역방향 프록시

1. **제어판 → 로그인 포털 → 고급 → 역방향 프록시**에서 규칙을 만듭니다.

   | 항목 | 값 |
   | --- | --- |
   | 소스 프로토콜 | `HTTPS` |
   | 소스 호스트 이름 | `notes.example.com` |
   | 소스 포트 | `443` |
   | 대상 프로토콜 | `HTTP` |
   | 대상 호스트 이름 | `127.0.0.1` 또는 BrainVault 내부 주소 |
   | 대상 포트 | `4000` |

2. **사용자 지정 헤더**에서 **생성 → WebSocket**을 선택합니다.
3. DSM 버전이 자동으로 추가하지 않는다면 `X-Forwarded-Proto` 헤더를 값 `$scheme`으로 추가합니다. BrainVault는 신뢰된 프록시가 `https`를 전달해야만 동작합니다.
4. DSM에서 `notes.example.com` 인증서를 지정합니다.
5. 선택 사항: HTTPS로 리디렉션하는 별도의 HTTP 소스 규칙을 추가합니다.

대상 포트는 외부에 공개하지 마세요. DSM에서 VPN/프록시 차단을 사용하려면 [연결 측정 가이드](network-verification.ko.md)도 따라 하세요.

### 3. 확인

로그에 `HTTPS reverse-proxy mode enabled`가 표시되어야 합니다. 이어서 다음을 실행합니다.

| 명령 | 기대 결과 |
| --- | --- |
| `curl -I http://127.0.0.1:4000/health` | `200` (내부 상태 점검) |
| `curl -I -H 'Host: notes.example.com' http://127.0.0.1:4000/` | `308` (`HTTPS_REDIRECT=false`이면 `426`) |
| `curl -I -H 'X-Forwarded-Proto: https' http://127.0.0.1:4000/` | `200` (신뢰된 프록시를 흉내 냄) |
| `curl -I https://notes.example.com/` | 리디렉션 반복 없이 앱이 표시됨 |

마지막으로 같은 공유 페이지를 브라우저 창 두 개에서 열어 실시간 협업이 동작하는지 확인합니다.

## 운영 시 주의사항

### 공개 진입점 요청 제한

- **인스턴스는 하나만 실행하세요.** 애플리케이션의 요청 제한 카운터는 프로세스 메모리에 있어 재시작하면 초기화됩니다. BrainVault는 수신을 시작하기 전에 MariaDB 데이터베이스에 대한 임대(lease)를 획득하며, 같은 데이터베이스에 두 번째 프로세스가 활성화되는 것을 거부합니다. 수평 확장은 지원하지 않습니다. 업로드/가져오기 허용 제어와 협업 조정에도 공유 백엔드가 필요하므로 프록시 제한을 추가해도 이 제약은 그대로입니다.
- **로그인 잠금은 별개입니다.** 로그인 잠금은 데이터베이스에 저장되며 이 카운터의 영향을 받지 않습니다.
- **프록시 제한은 앱 재시작 후에도 유지됩니다.** NGINX 예시는 `/api/`에 IP별 제한을, `/api/auth/`와 `/api/mfa/`에 더 엄격한 제한을 적용하고 HTTP 429를 반환합니다. 정적 파일과 `/health`는 제외됩니다. 공유 메모리 영역은 하나의 NGINX 진입점의 모든 worker에 적용됩니다.
- **제한 값을 조정하세요.** 자동 저장, 협업 재연결, 하나의 공유 NAT 뒤에 있는 많은 사용자를 고려해야 합니다. [NGINX `limit_req` 문서](https://nginx.org/en/docs/http/ngx_http_limit_req_module.html)를 참고하세요.
- **모든 백엔드를 내부에 두어** 공개 트래픽이 반드시 제한기를 거치게 하세요.
- **신뢰할 수 없는 전달 헤더를 제한 키로 쓰지 마세요.** NGINX 앞에 신뢰된 프록시가 더 있다면 그곳에서 실제 클라이언트 IP 처리를 설정하세요.
- **예시의 한계를 알아두세요.** 진입점 호스트가 여러 대라면 공유 엣지 제한기나 공유 저장소가 필요합니다. 예시에는 Redis 연동이나 계정별 전역 할당량이 없으며, WebSocket 프레임이 아닌 핸드셰이크만 제한합니다.

### 프록시 로그에 인증 정보 남기지 않기

모든 진입점에서 다음 헤더가 접근 로그, 트레이싱, WAF 캡처, 오류/디버그 로그에 남지 않게 하세요.

- `Sec-WebSocket-Protocol`
- `Cookie`, `Set-Cookie`
- `Authorization`

협업 WebSocket 서브프로토콜에는 페이지와 세션에 묶인 120초짜리 티켓이 들어 있습니다(일치하는 세션 쿠키도 함께 필요합니다). 티켓을 쿠키로 옮기지 마세요. 쿠키도 로그에서 가려야 하는 것은 마찬가지이고, 하나의 공유 쿠키는 여러 페이지 탭 사이에서 충돌합니다. 현재 전달 방식을 유지하고 로그 단계에서 가리세요.

NGINX 예시는 쿼리 문자열과 헤더를 기록하지 않는 최소한의 `brainvault_safe` 로그 형식을 이미 사용합니다. 운영 환경에서 전체 헤더 로깅을 켜지 마세요.

### 비밀번호 로그인 잠금 복구

비밀번호 시도 제한은 모든 네트워크에 걸쳐 계정 단위로 적용됩니다. 따라서 계정 ID를 아는 사람은 누구나 해당 계정의 비밀번호 로그인을 일시적으로 막을 수 있습니다.

| 제한 | 동작 |
| --- | --- |
| 저장된 잠금 | 30초로 시작하며, 만료 후 다시 실패하면 늘어나고, 최대 15분 |
| 계정 요청 한도 | 별도의 기본 한도로 6시간 유지 |

저장된 잠금만 지우면 요청 한도는 그대로 남고, 분산 추측 공격에 대한 보호만 약해집니다. 복구 방법은 다음과 같습니다.

1. **패스키(권장).** 검색 가능한(discoverable) 패스키를 미리 등록하세요. **패스키** 로그인은 별도의 제한을 사용하며, WebAuthn 인증이 검증되면 계정의 비밀번호 카운터와 저장된 잠금을 해제합니다.
2. **기존 세션.** 로그인된 세션에서 `POST /api/auth/login-lockout/reset`을 호출할 수 있습니다. 다른 계정은 해제할 수 없고 공유 IP 한도도 초기화하지 않습니다.
3. **대기.** 패스키나 세션이 없으면 제한이 만료될 때까지 비밀번호 로그인을 기다려야 합니다.

3번 상황을 위한 운영자 복구 절차를 마련해 두세요. 계정 ID만으로 동작하는 익명 초기화 기능은 제공하지 마세요.

## VPN/프록시 차단

VPN/프록시 차단은 신뢰된 진입점에서 측정한 TCP RTT와 서버가 측정한 WebSocket RTT를 비교합니다. Synology DSM 설정, TCP_INFO 헤더, 프록시 신뢰, 탐지 한계는 [연결 측정 가이드](network-verification.ko.md)를 참고하세요.

## 이 디렉터리의 파일

| 파일 | 내용 |
| --- | --- |
| [`README.md`](README.md) / `README.ko.md` / [`README.jp.md`](README.jp.md) | 이 HTTPS 배포 가이드 |
| [`network-verification.md`](network-verification.md) / [`.ko.md`](network-verification.ko.md) / [`.jp.md`](network-verification.jp.md) | VPN/프록시 차단을 위한 TCP/WebSocket 측정 |
| [`Caddyfile.example`](Caddyfile.example) | Caddy 리버스 프록시 예시 |
| [`nginx.conf.example`](nginx.conf.example) | 리디렉션, WebSocket, 요청 제한, 안전한 로그, TCP_INFO 헤더를 포함한 NGINX 예시 |

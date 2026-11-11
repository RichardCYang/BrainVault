[English](network-verification.md) | **한국어** | [日本語](network-verification.jp.md)

# VPN/프록시 차단: 연결 측정

BrainVault는 VPN이나 프록시를 거친 것으로 보이는 로그인을 차단할 수 있습니다. 같은 브라우저 연결의 지연 시간(RTT)을 두 가지 방법으로 측정해 비교하는 방식입니다. 이 문서는 설정 방법과 탐지할 수 있는 것과 없는 것을 설명합니다.

## 목차

- [한눈에 보기](#한눈에-보기)
- [동작 원리](#동작-원리)
- [Synology DSM 설정](#synology-dsm-설정)
- [다른 진입점 구성](#다른-진입점-구성)
- [문제 해결](#문제-해결)
- [설정 항목](#설정-항목)
- [판정 방식](#판정-방식)
- [제한 사항](#제한-사항)

## 한눈에 보기

- **리버스 프록시(HTTPS 진입점)가 필요합니다.** 이 프록시가 브라우저 연결의 TCP_INFO를 전달할 수 있어야 합니다. 직접 HTTPS 모드에서는 제공할 수 없습니다([자세히](#직접-https-모드)).
- **컨테이너에 추가할 것이 없습니다.** ICMP, ping, raw socket, `NET_RAW`, `NET_ADMIN`, privileged 모드가 필요 없습니다. 측정을 위한 외부 요청을 보내지 않고 외부 서비스(지리 기준점 서버, WebRTC 주소 탐색, VPN 평판 목록)도 사용하지 않습니다.
- **기본값은 꺼져 있습니다.** 프록시를 올바르게 설정한 뒤에만 TCP 측정값 신뢰를 켭니다.
- **완벽한 VPN 탐지기가 아닙니다.** 이 방식으로 탐지할 수 없는 VPN이 많습니다([자세히](#탐지할-수-있는-것과-없는-것)).

기본 HTTPS 설정이 아직이라면 [HTTPS 배포 가이드](README.ko.md)를 먼저 완료하세요.

## 동작 원리

```text
브라우저 -- HTTPS/WSS --> Synology DSM 역방향 프록시 -- HTTP/WS --> BrainVault 컨테이너
          ① 여기서 TCP RTT 측정                       ② WebSocket RTT는 전체 구간 측정
```

1. **TCP RTT**: 프록시가 브라우저→프록시 연결에 대해 커널이 측정한 지연 시간을 읽어 요청 헤더로 BrainVault에 전달합니다.
2. **WebSocket RTT**: BrainVault가 브라우저까지의 전체 왕복 시간을 측정합니다.
3. **비교**: WebSocket 지연이 TCP 지연보다 꾸준히 훨씬 크다면, 중간에 VPN이나 프록시 서버 같은 중계 지점이 있을 가능성이 높습니다.

> [!IMPORTANT]
> TCP 측정은 WebSocket 업그레이드가 지나가는 바로 그 연결, 즉 **브라우저→프록시** 연결에서 이루어져야 합니다. 프록시→컨테이너 연결을 측정하면 내부 구간만 반영되어 오탐이 발생합니다.

NAS나 Docker 주소가 사설 IP여도 괜찮습니다. 중요한 것은 BrainVault가 브라우저의 공개 주소와 진입점의 유효한 TCP 정보를 받는 것입니다.

## Synology DSM 설정

### 1단계. 역방향 프록시 규칙 준비

DSM의 **제어판 > 로그인 포털 > 고급 > 역방향 프록시**에서 BrainVault 규칙을 편집합니다(규칙이 없다면 [HTTPS 배포 가이드](README.ko.md#synology-dsm-역방향-프록시) 참고).

- 소스: HTTPS. 대상: 컨테이너의 내부 HTTP 주소.
- **사용자 지정 헤더**에서 **생성 > WebSocket**을 선택합니다.
- `Origin` 헤더를 유지하고, 신뢰된 전달 경로를 통해 `X-Forwarded-Proto: https`와 실제 클라이언트 주소를 전달합니다.

이 옵션은 Synology의 [DSM 역방향 프록시 안내](https://kb.synology.com/en-in/DSM/help/DSM/AdminCenter/system_login_portal_advanced)에도 설명되어 있습니다.

### 2단계. TCP 측정 헤더 추가

HTTPS 진입점에 다음 **요청 헤더**를 추가합니다. 클라이언트가 보낸 값은 반드시 **덮어써야** 합니다.

| 헤더 | NGINX 값 | 의미 |
| --- | --- | --- |
| `X-BrainVault-TCP-Peer-IP` | `$remote_addr` | 클라이언트 TCP 연결의 상대편 주소 |
| `X-BrainVault-TCP-RTT-Us` | `$tcpinfo_rtt` | 커널이 측정한 TCP RTT, 마이크로초 단위 |
| `X-BrainVault-TCP-RTTVar-Us` | `$tcpinfo_rttvar` | 커널이 측정한 TCP RTT 변동값, 마이크로초 단위 |

이 변수는 NGINX의 [TCP_INFO 지원](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_tcpinfo_rtt)에서 제공됩니다(단위는 [NGINX 소스](https://github.com/nginx/nginx/blob/master/src/http/ngx_http_variables.c) 참고).

> [!WARNING]
> DSM 버전과 빌드에 따라 지원 여부가 다릅니다. 사용자 지정 헤더 화면이 있다고 해서 이 변수가 존재하거나 실제 값으로 채워진다는 보장은 **없습니다**.
>
> - 생성된 프록시 설정에서 변수가 평가되고, WebSocket 업그레이드 요청에서 BrainVault가 **숫자**를 받는지 확인하세요.
> - `$tcpinfo_rtt` 문자열 그대로, 빈 값, RTT `0`은 거부됩니다.
> - 고정된 RTT 값을 직접 입력하지 마세요.
> - DSM 빌드가 TCP_INFO를 제공하지 못한다면 브라우저 연결을 직접 받는 다른 진입점이 필요합니다. DSM **뒤에** NGINX를 추가해도 원래 연결을 볼 수 없으므로 소용없습니다.

이 저장소는 NAS 자체의 설정을 바꾸지 않습니다.

### 3단계. BrainVault 설정

헤더 3개가 올바르게 생성되고 덮어쓰이는 것을 확인한 뒤 다음을 설정합니다. `TRUST_PROXY_ADDRESSES`에는 컨테이너가 실제로 보는 프록시 주소를 넣으세요.

```env
HTTPS_MODE=proxy
PUBLIC_ORIGIN="https://notes.example.com"
TRUST_PROXY_ADDRESSES="172.18.0.1"
TRUST_PROXY_HOPS=0
TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=false
VPN_TRUST_PROXY_TCP_INFO=true
VPN_PROXY_RTT_MARGIN_MS=10
VPN_MIN_EXCESS_RTT_MS=50
```

체크리스트:

- [ ] `TRUST_PROXY_ADDRESSES`를 가능한 한 좁게 지정했습니다.
- [ ] 컨테이너의 HTTP 포트가 외부에 공개되어 있지 않습니다.
- [ ] 덮어쓰기 규칙을 적용한 **뒤에만** `VPN_TRUST_PROXY_TCP_INFO=true`로 설정했습니다. (일반 프록시는 공격자가 보낸 헤더를 그대로 전달하므로 기본값이 `false`입니다.)
- [ ] `/api/network-verification/probe`와 `/api/collaboration/` 모두 WebSocket 업그레이드가 전달됩니다.

### 4단계. 앱에서 확인

1. **외부 네트워크**(예: 모바일 데이터를 쓰는 휴대폰)에서 접속합니다. 로컬 네트워크 접속은 의도적으로 예외 처리되므로 공개 경로 설정이 맞는지 증명하지 못합니다.
2. 계정 보안 설정에서 **연결 다시 측정**을 누릅니다.
3. 설정이 정상이면 **신뢰된 앞단에서 측정한 클라이언트 TCP RTT**와 측정된 WebSocket/TCP RTT가 표시됩니다.

문제가 있으면 화면에 TCP 정보 사용이 꺼져 있는지, TCP RTT가 없는지, 클라이언트 정보가 일치하지 않는지가 표시됩니다. [문제 해결](#문제-해결)을 참고하세요.

측정값과 판정 기준값은 인증 전 API로 공개되지 않습니다.

## 다른 진입점 구성

- **NGINX**: 동일한 설정이 [nginx.conf.example](nginx.conf.example)에 있습니다.
- **`real_ip`를 쓰는 NGINX**: `real_ip`가 `$remote_addr`를 바꾼다면 `X-BrainVault-TCP-Peer-IP`에 `$realip_remote_addr`를 사용해 원래 TCP 상대 주소를 유지하세요. 이 주소는 검증된 클라이언트 IP와 같아야 합니다.
- **앞에 CDN이나 TCP를 종료하는 다른 프록시가 있는 경우**: 진입점은 브라우저가 아니라 CDN과의 연결을 측정하게 됩니다. CDN의 클라이언트 IP 헤더를 전달해도 해결되지 않으며, 서로 맞지 않는 측정 정보는 거부됩니다.

## 문제 해결

| 화면에 보이는 것 | 예상 원인 | 해결 방법 |
| --- | --- | --- |
| TCP 정보 사용이 꺼져 있음 | `VPN_TRUST_PROXY_TCP_INFO`가 `false` | 2단계를 마친 뒤 `true`로 설정 |
| TCP RTT 없음 | 진입점이 숫자 형태의 TCP_INFO 헤더를 보내지 않음(`$tcpinfo_rtt` 문자열, 빈 값, `0`) | 생성된 프록시 설정 확인. TCP_INFO를 지원하는 진입점 사용 |
| 클라이언트 정보 불일치 | `X-BrainVault-TCP-Peer-IP`가 검증된 클라이언트 IP와 다름(`real_ip`, 앞단 CDN) | `$realip_remote_addr` 사용 또는 TCP를 종료하는 추가 구간 제거 |
| TCP 근거가 전혀 없음 | 중복되거나 잘못된 헤더, 신뢰되지 않은 프록시 주소, HTTPS가 아닌 전달, 잘못된 전달 경로 | `TRUST_PROXY_ADDRESSES` 확인, 헤더가 추가가 아니라 덮어쓰기되는지 확인 |
| LAN에서는 되는데 외부에서 실패 | 로컬망은 예외라 공개 경로가 실제로 시험되지 않았음 | 외부 네트워크에서 시험 |
| 보호된 요청이 약 20초 멈춤 | 브라우저 측정 실패 | 위 측정 설정 점검 |

## 설정 항목

| 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `VPN_TRUST_PROXY_TCP_INFO` | `false` | 명시적으로 신뢰한 로컬 HTTPS 진입점이 덮어쓴 TCP_INFO 헤더를 사용 |
| `VPN_MIN_EXCESS_RTT_MS` | `50` | 반복해서 관측되어야 하는 최소 추가 지연, 밀리초 단위(신뢰도 백분율 아님) |
| `VPN_PROXY_RTT_MARGIN_MS` | `10` | 로컬 리버스 프록시 구간의 추가 오차 여유 |
| `VPN_ALLOW_PRIVATE_NETWORK` | `true` | 직접 LAN 접속 유지. 프록시를 거쳐 들어오는 사설망 클라이언트는 `TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=true`도 필요 |
| `VPN_POLICY_FAIL_CLOSED` | `true` | 차단을 켠 계정에서 측정 근거가 없으면 접근 거부 |

**측정에 실패하면 어떻게 되나요?**

- 측정 실패는 터널 탐지와 **다릅니다**.
- `VPN_POLICY_FAIL_CLOSED=true`이면 차단을 켠 계정은 근거가 없을 때도 접근이 거부됩니다. `false`이면 측정 실패는 허용하지만 탐지된 터널은 계속 차단합니다.
- 차단을 끈 계정은 항상 접근할 수 있습니다.
- 현재 연결을 즉시 차단하게 되는 차단 정책은 켤 수 없습니다.
- 기존의 비밀번호/MFA 재인증과 세션 해제 보호는 그대로 적용됩니다. 과거 차단 기록과 별도의 국가별 로그인 제한도 계속 조회할 수 있습니다.

## 판정 방식

| 결과 | 의미 |
| --- | --- |
| `CLEAR` | TCP/WebSocket 사이에 추가 지연이 관측되지 않음. VPN이 없다는 **증명은 아닙니다**. |
| `TUNNEL` | 일관된 추가 지연이 관측됨. VPN/프록시로 간주합니다. |
| `INCONCLUSIVE` | 지연이 불안정해 판단할 수 없음(WebSocket 지연 불안정, TCP 변동 큼, 추정값 불일치). |
| `UNKNOWN` | TCP 근거가 없음. 완료된 WebSocket 표본은 유지합니다. |

<details>
<summary>측정 상세</summary>

1. 브라우저가 동일 출처의 일회용 티켓을 요청하고 `/api/network-verification/probe`에 연결합니다.
2. 서버가 그 업그레이드 요청의 TCP_INFO 메타데이터를 기록합니다.
3. 서버가 예측할 수 없는 WebSocket ping 프레임을 12번 보내고, 일치하는 pong 프레임의 왕복 시간을 단조 시계로 잽니다. 이 프레임은 TCP 기반 WebSocket 제어 프레임이며 ICMP 패킷이 아닙니다.
4. 브라우저는 내용을 알 수 없는 완료 토큰만 제출합니다. 클라이언트가 주장하는 RTT나 판정은 무시됩니다.
5. 12개 표본은 6개씩 연속된 두 구간으로 나뉩니다. **두 구간 모두** TCP RTT + `VPN_MIN_EXCESS_RTT_MS` + `VPN_PROXY_RTT_MARGIN_MS` + TCP RTT 변동값의 3배를 넘어야 `TUNNEL`입니다. RTT가 높다는 이유만으로는 탐지하지 않습니다. 하나의 TCP 스냅샷을 여러 번의 독립 측정으로 취급하지 않습니다.

**결과 저장 방식**

- 완료 토큰은 `HttpOnly`, `SameSite=Strict` 속성의 불투명한 쿠키로 교환됩니다(HTTPS에서는 `Secure`와 `__Host-` 접두사도 사용).
- 결과는 해당 브라우저와 정확히 정규화된 클라이언트 IP에 묶이며, 5분 후 만료되고 페이지가 보이는 동안 갱신됩니다.
- 같은 NAT 뒤의 다른 브라우저끼리는 결과를 공유하지 않습니다.
- 비밀번호 로그인, MFA, 패스키, 인증된 요청, 협업 재검증에 적용됩니다.

</details>

## 제한 사항

### 자원 제한

| 항목 | 제한 |
| --- | --- |
| 활성 측정 소켓 | 전체 32개, 출발지 IP당 4개 |
| 티켓 | 출발지 IP당 분당 30개 |
| 측정 시간 | 12초 |
| WebSocket 표본 | 12개 |
| 내부 상태 | 크기 제한과 만료가 있는 맵 |

티켓이 담긴 서브프로토콜, 완료 토큰, 쿠키는 로그에 남기지 마세요. 측정이 실패하면 다음 보호된 요청이 약 20초 지연될 수 있습니다.

### 탐지할 수 있는 것과 없는 것

- **탐지 가능**: TCP 연결은 중계 지점에서 분리되고 WebSocket 스트림은 브라우저까지 이어져 안정적인 추가 지연이 생기는 경우.
- **확실히 탐지할 수 없음**:
  - 모든 가정 IP 기반 VPN.
  - TCP 연결을 종단 간 그대로 전달하는 WireGuard, OpenVPN 등의 터널. 이 경우 TCP RTT와 WebSocket RTT가 함께 늘어납니다.
  - 서버와 매우 가까운 중계 서버, 또는 WebSocket 제어 프레임에 직접 응답하는 중계 서버.
- 네트워크 부하와 진입점의 처리 일정은 두 측정값 모두에 영향을 줍니다.
- 실제로 활용하기 전에 구분된 트래픽(직접 접속, 모바일, 혼잡 회선, 로컬 프록시, 가정 IP VPN)으로 보정하고, 오탐률과 근거 확보 비율을 따로 측정하세요. 탐지 정확도 백분율은 보장하지 않습니다.

### 직접 HTTPS 모드

Node.js가 HTTPS를 직접 제공하는 모드(`HTTPS_MODE=posh-acme`)는 WebSocket RTT는 측정하지만 내장 TCP_INFO 수집기가 없습니다. 이 경우 `DIRECT_TCP_INFO_UNAVAILABLE`로 표시되며, 요청 헤더로 커널 소켓 데이터를 대신할 수 없습니다. TCP 수집 기능은 위에서 설명한 DSM/NGINX 진입점 구성을 대상으로 합니다.

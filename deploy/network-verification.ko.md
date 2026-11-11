[English](network-verification.md) | **한국어** | [日本語](network-verification.jp.md)

# VPN/프록시 차단을 위한 TCP/WebSocket 측정

탐지기는 HTTPS 앞단에서 측정한 원래 클라이언트의 TCP RTT와 서버에서 측정한 WebSocket 왕복시간을 비교합니다. 측정을 위한 외부 요청이나 별도 프로세스를 실행하지 않습니다. ICMP, ping 실행 파일, raw socket, 지리 기준점 서버, WebRTC 주소 탐색, VPN 평판 서비스를 사용하지 않습니다. 이 기능을 위해 컨테이너에 `NET_RAW`, `NET_ADMIN`, privileged 모드 또는 ping 패키지를 추가할 필요가 없습니다.

## Synology DSM: HTTPS 앞단에서 HTTP 컨테이너로 전달

지원하는 배포 경로는 다음과 같습니다.

```text
브라우저 -- HTTPS/WSS --> Synology DSM 역방향 프록시 -- HTTP/WS --> BrainVault 컨테이너
          클라이언트 TCP RTT 측정 구간              WebSocket은 전체 구간 측정
```

TCP 측정값은 WebSocket 업그레이드 요청이 전달되는 동일한 클라이언트 연결의 **브라우저↔DSM 구간**을 나타내야 합니다. 컨테이너 소켓을 측정하면 DSM↔컨테이너 구간만 나타내므로 오탐이 발생할 수 있습니다. NAS/Docker 주소가 사설 IP라는 이유만으로 검증 불가가 되는 것은 아닙니다. 비교에는 실제 공개 클라이언트 주소와 유효한 앞단 TCP 정보가 필요합니다.

DSM의 **제어판 > 로그인 포털 > 고급 > 역방향 프록시**에서 BrainVault 규칙을 편집합니다. 원본은 HTTPS, 대상은 내부 컨테이너의 HTTP 주소로 유지합니다. **사용자 지정 헤더**에서 **생성 > WebSocket**을 선택합니다. `Origin`을 보존하고 기존의 신뢰된 전달 경로를 통해 `X-Forwarded-Proto: https`와 실제 클라이언트 주소를 전달합니다. WebSocket 및 사용자 지정 헤더 설정은 Synology의 [DSM 역방향 프록시 안내](https://kb.synology.com/en-in/DSM/help/DSM/AdminCenter/system_login_portal_advanced)에서도 확인할 수 있습니다.

HTTPS 앞단에서 다음 **요청 헤더**를 설정하고 외부 요청의 기존 값을 덮어씁니다.

| 헤더 | NGINX 값 | 용도 |
| --- | --- | --- |
| `X-BrainVault-TCP-Peer-IP` | `$remote_addr` | 클라이언트 연결의 실제 TCP 상대 주소 |
| `X-BrainVault-TCP-RTT-Us` | `$tcpinfo_rtt` | 커널이 측정한 TCP RTT, 마이크로초 단위 |
| `X-BrainVault-TCP-RTTVar-Us` | `$tcpinfo_rttvar` | 커널이 측정한 TCP RTT 변동값, 마이크로초 단위 |

이 변수는 NGINX의 [TCP_INFO 지원](https://nginx.org/en/docs/http/ngx_http_core_module.html#var_tcpinfo_rtt)을 사용하며, [NGINX 구현](https://github.com/nginx/nginx/blob/master/src/http/ngx_http_variables.c)은 커널의 RTT와 변동값을 마이크로초 단위로 전달합니다. DSM 버전과 빌드에 따라 지원 여부가 다릅니다. 사용자 지정 헤더 설정 화면이 있다는 것만으로 이 변수를 사용할 수 있거나 실제 값으로 치환된다는 보장은 없습니다. 생성된 프록시 설정에서 변수가 평가되고, WebSocket 업그레이드 요청의 헤더가 백엔드에 숫자로 전달되는지 확인하세요. `$tcpinfo_rtt` 문자열 자체, 빈 값, RTT 0은 거부됩니다. 임의의 고정 RTT 값으로 대체하지 마세요. DSM 빌드에서 TCP_INFO를 제공할 수 없다면 원래 클라이언트 연결을 받는 앞단에 TCP_INFO 지원이 필요합니다. DSM **뒤에** NGINX를 추가해도 원래 연결의 정보를 복구할 수 없습니다. 이 저장소의 변경으로 NAS 자체의 설정이 바뀌지는 않습니다.

동일한 NGINX 설정은 [nginx.conf.example](nginx.conf.example)에 있습니다. NGINX의 `real_ip`가 `$remote_addr`를 다시 쓰는 경우에는 `X-BrainVault-TCP-Peer-IP`에 `$realip_remote_addr`를 사용해 원래 TCP 상대 주소를 유지합니다. 이 주소는 검증된 클라이언트 IP와 같아야 합니다. DSM 앞에 CDN이나 TCP 연결을 종료하는 다른 프록시가 있으면 DSM이 측정하는 연결은 달라집니다. CDN의 클라이언트 IP 헤더를 전달해도 DSM의 TCP RTT가 브라우저의 RTT로 바뀌지는 않습니다. 서로 일치하지 않는 측정 정보는 거부됩니다.

헤더 3개가 올바르게 생성되고 기존 값을 덮어쓰는 것을 확인한 뒤, 컨테이너가 실제로 관측하는 프록시 주소에 맞춰 설정합니다.

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

프록시 신뢰 범위는 가능한 한 좁게 지정하고 컨테이너의 HTTP 포트는 외부에 공개하지 않습니다. 일반 프록시는 공격자가 보낸 사용자 지정 헤더를 그대로 전달할 수 있으므로 TCP_INFO 신뢰 설정의 기본값은 **false**입니다. 덮어쓰기 규칙을 적용한 뒤에만 활성화하세요. 중복 헤더, 잘못된 값, 신뢰되지 않은 상대, HTTPS가 아닌 전달, 유효하지 않은 전달 경로, 실제 TCP 상대와 클라이언트 IP의 불일치는 TCP 측정 근거로 인정되지 않습니다. `/api/network-verification/probe`와 `/api/collaboration/` 두 경로 모두 WebSocket 업그레이드를 전달해야 합니다.

계정 보안 설정에서 **연결 다시 측정**을 사용합니다. 설정이 정상이라면 **신뢰된 앞단에서 측정한 클라이언트 TCP RTT**와 측정된 WebSocket/TCP RTT가 표시됩니다. 화면은 TCP 정보 사용 설정이 꺼진 상태, TCP RTT 누락, 클라이언트 정보 불일치를 구분합니다. 외부 네트워크에서 접속해 확인하세요. 의도된 로컬망 예외로 접속이 허용되었다고 해서 공개 앞단 설정까지 검증된 것은 아닙니다. 인증 전 API에서는 측정값이나 판정 임계값을 공개하지 않습니다.

## 측정과 판정

브라우저는 동일 출처의 일회용 티켓을 요청하고 `/api/network-verification/probe`에 연결합니다. 서버는 해당 업그레이드 요청의 TCP_INFO 메타데이터를 읽고, 예측할 수 없는 WebSocket 프로토콜 ping 프레임을 12회 보내 일치하는 pong 응답의 왕복시간을 단조 시계로 측정합니다. 이 프레임은 TCP 기반 WebSocket 제어 프레임이며 네트워크 ICMP 패킷이 아닙니다. 브라우저는 내용을 해석할 수 없는 완료 토큰만 제출하며, 클라이언트가 주장하는 RTT나 판정은 무시됩니다.

6개 표본으로 이루어진 연속 두 WebSocket 측정 구간을 앞단의 실제 TCP 스냅샷과 비교합니다. 두 구간 모두 TCP RTT에 최소 추가 지연, 로컬 프록시 오차 여유, TCP RTT 변동값의 3배를 더한 기준을 초과해야 `TUNNEL`로 판정합니다. RTT가 높다는 이유만으로 탐지하지 않습니다. WebSocket 지연이 불안정하거나 TCP 변동값이 크거나 추정값이 서로 맞지 않으면 `INCONCLUSIVE`입니다. TCP 측정 근거가 없으면 `UNKNOWN`으로 처리하고 완료된 WebSocket 표본은 유지합니다. 하나의 TCP 스냅샷을 여러 번 독립적으로 측정한 것처럼 취급하지 않습니다.

측정 완료 후에는 일회용 완료 토큰을 HttpOnly, SameSite=Strict 속성의 불투명한 쿠키로 교환합니다. HTTPS에서는 Secure 속성과 `__Host-` 접두사도 사용합니다. 측정 근거는 브라우저별 식별자와 정확히 정규화된 클라이언트 IP에 연결되며 5분 후 만료됩니다. 페이지가 표시되는 동안 주기적으로 갱신합니다. 같은 NAT를 공유하는 별도 브라우저끼리 판정을 공유하지 않습니다. 비밀번호 로그인, MFA, 패스키, 인증된 요청, 협업 재검증에서 이 측정 근거를 적용합니다.

## 정책과 제한

| 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `VPN_TRUST_PROXY_TCP_INFO` | `false` | 명시적으로 신뢰한 로컬 HTTPS 앞단이 덮어써서 전달하는 TCP_INFO 사용 |
| `VPN_MIN_EXCESS_RTT_MS` | `50` | 반복 관측해야 하는 최소 추가 지연, 밀리초 단위이며 신뢰도 백분율이 아님 |
| `VPN_PROXY_RTT_MARGIN_MS` | `10` | 로컬 역방향 프록시 구간의 추가 오차 여유 |
| `VPN_ALLOW_PRIVATE_NETWORK` | `true` | 직접 LAN 접속 유지. 프록시를 거치는 사설망 클라이언트는 `TRUST_PROXY_ALLOW_PRIVATE_CLIENTS=true`도 필요 |
| `VPN_POLICY_FAIL_CLOSED` | `true` | 차단 정책을 켠 계정에서 측정 근거가 없으면 접근 거부 |

측정 불가는 터널 탐지와 다릅니다. 다만 fail-closed가 켜져 있으면 계정의 차단 정책에 따라 접근이 거부될 수 있습니다. false이면 측정 실패 시 접근을 허용하지만 탐지된 터널의 차단을 해제하지는 않습니다. 차단 정책을 끈 계정은 계속 접근할 수 있습니다. 현재 연결을 즉시 차단하게 되는 정책 활성화 요청은 거부합니다. 기존의 비밀번호/MFA 재인증과 세션 해제 보호는 그대로 적용됩니다. 과거 차단 기록과 별도의 국가별 로그인 제한도 계속 조회할 수 있습니다.

자원 제한은 전체 활성 측정 소켓 32개, 출발지 IP당 4개, 출발지 IP당 분당 티켓 30개, 크기와 유효기간이 제한된 맵, 측정 제한 시간 12초, WebSocket 표본 12개입니다. 티켓이 담긴 서브프로토콜, 완료 토큰, 쿠키는 로그에 남기지 않아야 합니다. 브라우저 측정이 실패하면 뒤따르는 보호된 요청이 약 20초 지연될 수 있습니다. 추가 컨테이너 권한이나 외부 기준점 목록은 필요하지 않습니다.

## 탐지 범위

이 비교는 중계 지점에서 TCP 연결이 분리되고 WebSocket 스트림은 브라우저까지 이어지는 경우, 안정적으로 반복되는 추가 경로 지연을 드러낼 수 있습니다. 모든 가정 IP 기반 VPN을 확실하게 식별할 수는 없습니다. WireGuard/OpenVPN 등의 터널은 클라이언트의 TCP 연결을 종단 간 전달할 수 있으므로 TCP RTT와 WebSocket RTT가 함께 증가할 수 있습니다. 가까운 중계 서버나 WebSocket 제어 프레임에 직접 응답하는 중계 서버도 이 비교를 회피할 수 있습니다. `CLEAR`는 TCP/WebSocket 사이의 추가 지연 차이가 관측되지 않았다는 뜻이며 VPN이 없음을 보증하지 않습니다. 네트워크 부하와 앞단의 처리 일정은 두 측정값 모두에 영향을 줄 수 있습니다. 직접 접속, 모바일, 혼잡한 회선, 로컬 프록시, 가정 IP 기반 VPN으로 구분된 실제 트래픽으로 보정하고 오탐률과 측정 근거 확보 비율을 따로 평가하세요. 배포 환경의 탐지 정확도 백분율을 보장하지 않습니다.

Node.js가 HTTPS를 직접 제공하는 모드에는 현재 WebSocket 측정만 있고 네이티브 TCP_INFO 수집기는 없습니다. 이 경우 `DIRECT_TCP_INFO_UNAVAILABLE`로 표시하며 요청 헤더를 커널 소켓 데이터 대신 사용할 수 없습니다. 구현된 TCP 수집 경로는 위의 DSM/NGINX 앞단 배포 구성을 대상으로 합니다.

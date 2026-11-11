const keys = ["vpnBlockDescription", "vpnBlockWarning", "vpnBlockRiskClear", "vpnBlockRiskUnknown", "vpnBlockRiskTunnel", "vpnBlockRiskInconclusive", "vpnMeasurementLocal", "vpnMeasurementLocalProxy", "vpnMeasurementTcpProxy", "vpnMeasurementTcpDirect", "vpnMeasurementUnstable", "vpnMeasurementTcpMismatch", "vpnMeasurementProxyUnsupported", "vpnMeasurementRequired", "vpnMeasurementUnavailable", "vpnMeasurementTcpUnavailable", "vpnMeasurementTcpDisabled", "vpnMeasurementExcess", "vpnMeasurementRtt", "vpnVerificationUnavailable"];
const messages = {
  en: [
    "Compare TCP and WebSocket round trips to restrict access when repeated measurements suggest an additional relay path.",
    "VPNs that forward TCP end to end may remain undetected. Missing TCP measurements follow the server verification policy. Saving revokes other active sessions.",
    "No TCP/WebSocket delay gap observed", "Measurement unavailable", "Repeated measurements suggest an additional relay", "Inconclusive connection measurements",
    "Local-network exemption", "Trusted local reverse proxy; delay margin applied", "Client TCP RTT measured at the trusted ingress", "Client TCP RTT measured on the socket",
    "Network timing is unstable", "TCP information does not identify the verified client connection", "This proxy path needs a supported measurement endpoint", "A connection measurement is required",
    "Connection measurement is unavailable", "Client TCP RTT is unavailable", "Configure trusted ingress TCP information and enable it on the server", "Additional delay repeated across both windows",
    "WebSocket {application} ms · TCP {tcp} ms", "Connection measurement is unavailable. Retry the network check."
  ],
  ko: [
    "TCP와 WebSocket 왕복시간을 비교해 반복 측정에서 추가 중계 경로가 의심되면 접근을 제한합니다.",
    "TCP를 종단 간 전달하는 VPN은 탐지되지 않을 수 있습니다. TCP 측정 자료가 없으면 서버의 검증 정책을 따릅니다. 저장하면 다른 활성 세션이 해제됩니다.",
    "TCP/WebSocket 간 추가 지연이 관측되지 않음", "측정 자료 부족", "반복 측정에서 추가 중계 경로 의심", "측정 결과 불명확",
    "로컬망 접속 예외", "신뢰된 로컬 역방향 프록시 · 지연 오차 반영", "신뢰된 앞단에서 측정한 클라이언트 TCP RTT", "클라이언트 소켓에서 측정한 TCP RTT",
    "네트워크 지연이 불안정함", "TCP 정보가 확인된 클라이언트 연결과 일치하지 않음", "이 프록시 경로에서는 별도의 측정 구성이 필요함", "연결 측정 필요",
    "연결을 측정할 수 없음", "클라이언트 TCP RTT를 가져올 수 없음", "앞단 프록시의 TCP 정보 전달 설정과 서버의 신뢰 설정 필요", "두 측정 구간에서 추가 지연 반복 관측",
    "WebSocket {application} ms · TCP {tcp} ms", "연결을 측정할 수 없습니다. 네트워크 확인을 다시 시도해 주세요."
  ],
  ja: [
    "TCPとWebSocketの往復時間を比較し、繰り返し測定で追加の中継経路が疑われる場合にアクセスを制限します。",
    "TCPをエンドツーエンドで転送するVPNは検出できない場合があります。TCP測定がない場合はサーバーの検証ポリシーに従います。保存すると他のセッションは無効になります。",
    "TCPとWebSocketの追加遅延差は観測されませんでした", "測定データ不足", "繰り返し測定で追加の中継経路の疑い", "測定結果が不明確",
    "ローカルネットワークの例外", "信頼されたローカルプロキシ・遅延誤差を考慮", "信頼された入口で測定したクライアントTCP RTT", "クライアントソケットで測定したTCP RTT",
    "ネットワーク遅延が不安定", "TCP情報が確認済みのクライアント接続と一致しません", "このプロキシ経路には別の測定構成が必要です", "接続の測定が必要",
    "接続を測定できません", "クライアントTCP RTTを取得できません", "入口プロキシでTCP情報の転送を設定し、サーバーで信頼を有効にしてください", "両方の測定区間で追加遅延を観測",
    "WebSocket {application} ms・TCP {tcp} ms", "接続を測定できません。ネットワークの確認を再試行してください。"
  ],
  fr: [
    "Compare les temps aller-retour TCP et WebSocket pour restreindre les accès si des mesures répétées suggèrent un relais supplémentaire.",
    "Les VPN transférant TCP de bout en bout peuvent rester indétectables. Sans mesure TCP, la politique du serveur s'applique. Enregistrer révoque les autres sessions.",
    "Aucun écart de délai TCP/WebSocket observé", "Mesure indisponible", "Mesures répétées indiquant un relais supplémentaire", "Mesures non concluantes",
    "Exemption du réseau local", "Proxy inverse local approuvé ; marge appliquée", "RTT TCP du client mesuré au point d'entrée approuvé", "RTT TCP mesuré sur le socket du client",
    "Latence réseau instable", "Les informations TCP ne correspondent pas à la connexion client vérifiée", "Ce chemin proxy nécessite un point de mesure pris en charge", "Mesure de connexion requise",
    "Mesure de connexion indisponible", "RTT TCP du client indisponible", "Configurez les informations TCP du proxy d'entrée et activez leur confiance sur le serveur", "Délai supplémentaire dans les deux périodes",
    "WebSocket {application} ms · TCP {tcp} ms", "Mesure indisponible. Réessayez la vérification réseau."
  ],
  de: [
    "Vergleicht TCP- und WebSocket-Laufzeiten und beschränkt Zugriffe, wenn wiederholte Messungen auf einen zusätzlichen Relaypfad hinweisen.",
    "VPNs mit durchgängiger TCP-Weiterleitung können unerkannt bleiben. Bei fehlenden TCP-Messungen gilt die Serverrichtlinie. Speichern widerruft andere Sitzungen.",
    "Keine zusätzliche TCP/WebSocket-Verzögerung beobachtet", "Messung nicht verfügbar", "Wiederholte Messungen deuten auf ein zusätzliches Relay hin", "Messungen nicht eindeutig",
    "Ausnahme für lokales Netzwerk", "Vertrauenswürdiger lokaler Proxy; Toleranz angewendet", "Client-TCP-RTT am vertrauenswürdigen Eingang gemessen", "TCP-RTT am Client-Socket gemessen",
    "Netzwerklatenz instabil", "TCP-Informationen stimmen nicht mit der geprüften Client-Verbindung überein", "Dieser Proxypfad benötigt einen unterstützten Messendpunkt", "Verbindungsmessung erforderlich",
    "Verbindungsmessung nicht verfügbar", "Client-TCP-RTT nicht verfügbar", "TCP-Informationen am Eingangsproxy konfigurieren und auf dem Server freigeben", "Zusätzliche Verzögerung in beiden Messfenstern",
    "WebSocket {application} ms · TCP {tcp} ms", "Messung nicht verfügbar. Netzwerkprüfung erneut versuchen."
  ],
  es: [
    "Compara los tiempos de ida y vuelta TCP y WebSocket para restringir el acceso si las mediciones repetidas sugieren un relevo adicional.",
    "Las VPN que reenvían TCP de extremo a extremo pueden no detectarse. Sin mediciones TCP se aplica la política del servidor. Guardar revoca otras sesiones.",
    "No se observó diferencia adicional entre TCP y WebSocket", "Medición no disponible", "Las mediciones repetidas sugieren un relevo adicional", "Mediciones no concluyentes",
    "Exención de red local", "Proxy inverso local de confianza; margen aplicado", "RTT TCP del cliente medido en la entrada de confianza", "RTT TCP medido en el socket del cliente",
    "Latencia de red inestable", "La información TCP no coincide con la conexión del cliente verificada", "Esta ruta proxy necesita un punto de medición compatible", "Se requiere medir la conexión",
    "Medición de conexión no disponible", "RTT TCP del cliente no disponible", "Configura la información TCP del proxy de entrada y habilita su confianza en el servidor", "Demora adicional en ambos periodos",
    "WebSocket {application} ms · TCP {tcp} ms", "Medición no disponible. Repite la comprobación de red."
  ],
  pt: [
    "Compara os tempos de ida e volta TCP e WebSocket para restringir o acesso se medições repetidas sugerirem um retransmissor adicional.",
    "VPNs que encaminham TCP de ponta a ponta podem não ser detectadas. Sem medições TCP, aplica-se a política do servidor. Salvar revoga outras sessões.",
    "Nenhuma diferença adicional entre TCP e WebSocket observada", "Medição indisponível", "Medições repetidas sugerem um retransmissor adicional", "Medições inconclusivas",
    "Exceção de rede local", "Proxy reverso local confiável; margem aplicada", "RTT TCP do cliente medido na entrada confiável", "RTT TCP medido no socket do cliente",
    "Latência de rede instável", "As informações TCP não correspondem à conexão verificada do cliente", "Este caminho proxy precisa de um ponto de medição compatível", "Medição da conexão necessária",
    "Medição da conexão indisponível", "RTT TCP do cliente indisponível", "Configure as informações TCP do proxy de entrada e habilite a confiança no servidor", "Atraso adicional nos dois períodos",
    "WebSocket {application} ms · TCP {tcp} ms", "Medição indisponível. Tente a verificação de rede novamente."
  ]
};
export const networkMeasurementTranslations = Object.fromEntries(Object.entries(messages)
  .map(([language, values]) => [language, Object.fromEntries(keys.map((key, index) => [key, values[index]]))]));
for (const [language, value] of Object.entries({ en: "Measure connection again", ko: "연결 다시 측정", ja: "接続を再測定", fr: "Mesurer à nouveau", de: "Verbindung erneut messen", es: "Medir de nuevo", pt: "Medir novamente" })) {
  networkMeasurementTranslations[language].vpnMeasurementRefresh = value;
}

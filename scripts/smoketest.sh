#!/usr/bin/env bash
# Rooktest van de hele keten, tegen een draaiende Docker Compose-omgeving.
#
#   docker compose up -d --build
#   ./scripts/smoketest.sh              # basis: happy path, wijziging, intrekking, ongeldig bericht (circa 1 minuut)
#   ./scripts/smoketest.sh --volledig   # voegt toe: API-uitval, broker-uitval, dubbel bericht (stopt en start containers, 3 tot 5 minuten)
#
# Controleert per stap de bron-app, de database van de werkorder-api, Kafka (Redpanda) en Artemis.
# Exitcode 0 = alles groen, 1 = minstens één controle rood. Een regel INFO is geen fout, maar een vraag aan jou.
set -u
cd "$(dirname "$0")/.."

VOLLEDIG=0; [ "${1:-}" = "--volledig" ] && VOLLEDIG=1
[ -f .env ] && { set -a; . ./.env; set +a; }
ARTEMIS_USER="${ARTEMIS_USER:-artemis}"; ARTEMIS_PASSWORD="${ARTEMIS_PASSWORD:-artemis}"
BRON="http://localhost:8095"
DC="docker compose"
OK=0; FOUT=0; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

groen() { printf '  \033[32mOK\033[0m    %s\n' "$*"; OK=$((OK+1)); }
rood()  { printf '  \033[31mFOUT\033[0m  %s\n' "$*"; FOUT=$((FOUT+1)); }
info()  { printf '  \033[33mINFO\033[0m  %s\n' "$*"; }
kop()   { printf '\n\033[1m%s\033[0m\n' "$*"; }
controle() { local naam="$1"; shift; if "$@"; then groen "$naam"; else rood "$naam"; fi; }

# JSON-veld uit stdin lezen (Node is toch al nodig voor dit project)
jget() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const v=JSON.parse(s);const r=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],v);console.log(r===undefined||r===null?"":typeof r==="object"?JSON.stringify(r):r)}catch(e){console.log("")}})' "$1"; }
wacht_tot() { # wacht_tot <seconden> <commando...>
  local tot=$1; shift; local einde=$((SECONDS+tot))
  while [ $SECONDS -lt $einde ]; do "$@" && return 0; sleep 1; done; return 1
}
gezond() { [ "$($DC ps --format '{{.Health}}' "$1" 2>/dev/null)" = "healthy" ]; }
wacht_gezond() { wacht_tot "${2:-120}" gezond "$1"; }

wo_id() { printf 'WO-%d' "$((10#${1#WOP-}))"; }          # WOP-002001 -> WO-2001
db_rij() { # db_rij WO-2001 -> JSON of lege regel
  $DC exec -T werkorder-api node --disable-warning=ExperimentalWarning -e '
    const {DatabaseSync}=require("node:sqlite");
    const d=new DatabaseSync("/data/werkorders.db",{readOnly:true});
    const r=d.prepare("select versie,status,ingetrokken from werkorders where werkorder_id=?").get(process.argv[1]);
    console.log(r?JSON.stringify(r):"");' "$1" 2>/dev/null
}
db_versie() { db_rij "$1" | jget versie; }
versie_is() { [ "$(db_versie "$1")" = "$2" ]; }
status_is() { [ "$(db_rij "$1" | jget status)" = "$2" ]; }
ingetrokken_is() { [ "$(db_rij "$1" | jget ingetrokken)" = "$2" ]; }
wacht_versie() { wacht_tot "${3:-30}" versie_is "$1" "$2"; }
queue_is() { [ "$(queue_aantal "$1")" = "$2" ]; }
dlq_aantal_is() { [ "$(queue_aantal eam.workorder.v1.dlq)" = "$1" ]; }

queue_aantal() { # queue_aantal <queue> -> aantal berichten (via Jolokia) of lege regel
  local q="$1"
  curl -s -m 5 -u "$ARTEMIS_USER:$ARTEMIS_PASSWORD" -H "Origin: http://localhost" \
    "http://localhost:8161/console/jolokia/read/org.apache.activemq.artemis:broker=%22eam-broker%22,component=addresses,address=%22${q}%22,subcomponent=queues,routing-type=%22anycast%22,queue=%22${q}%22/MessageCount" | jget value
}

dlq_leegmaken() { # haalt de testberichten weer uit de DLQ (Jolokia: removeAllMessages)
  local q=eam.workorder.v1.dlq
  curl -s -m 5 -u "$ARTEMIS_USER:$ARTEMIS_PASSWORD" -H "Origin: http://localhost" \
    "http://localhost:8161/console/jolokia/exec/org.apache.activemq.artemis:broker=%22eam-broker%22,component=addresses,address=%22${q}%22,subcomponent=queues,routing-type=%22anycast%22,queue=%22${q}%22/removeAllMessages()" >/dev/null
}
dlq_is() { [ "$(queue_aantal eam.workorder.v1.dlq)" = "$1" ]; }
log_heeft() { $DC logs target-adapter 2>/dev/null | grep -q "$1"; }

# Zet een ruw bericht rechtstreeks op de queue (via rhea in de source-adapter-container), langs de source-adapter heen
zet_op_queue() { # zet_op_queue <messageId> ; body op stdin
  local id="$1"
  $DC exec -T -e MID="$id" source-adapter node -e '
    const rhea=require("rhea"); const body=require("fs").readFileSync(0,"utf8");
    const c=rhea.connect({host:process.env.BROKER_HOST,port:Number(process.env.BROKER_PORT),username:process.env.BROKER_USER,password:process.env.BROKER_PASSWORD,reconnect:false});
    c.open_sender("eam.workorder.v1");
    c.on("sendable",x=>x.sender.send({message_id:process.env.MID,durable:true,application_properties:{workOrderId:"WO-9999"},body}));
    c.on("accepted",()=>{console.log("ok");c.close();});
    c.on("rejected",()=>{console.log("rejected");process.exit(1);});
    setTimeout(()=>{console.log("time-out");process.exit(1);},10000);' 2>/dev/null | grep -q '^ok$'
}

# HTTP-status van een aanroep aan de werkorder-api, vanuit de Compose-omgeving (de API staat niet op de host)
api_status() { # api_status <METHOD> <pad> [token]
  $DC exec -T -e TOK="${3:-}" -e METHOD="$1" -e URLPAD="$2" target-adapter node -e '
    fetch("http://werkorder-api:8081"+process.env.URLPAD,{method:process.env.METHOD,
      headers:{"Content-Type":"application/json",...(process.env.TOK?{Authorization:"Bearer "+process.env.TOK}:{})},
      body:process.env.METHOD==="PUT"?"{}":undefined}).then(r=>console.log(r.status)).catch(e=>console.log("fout"))' 2>/dev/null | tr -d '\r'
}
service_token() { # token van het service-account, opgehaald zoals de target-adapter dat doet
  $DC exec -T target-adapter node -e '
    fetch(process.env.OIDC_TOKEN_URL,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({grant_type:"client_credentials",client_id:process.env.OIDC_CLIENT_ID,client_secret:process.env.OIDC_CLIENT_SECRET})})
      .then(r=>r.json()).then(j=>console.log(j.access_token||"")).catch(()=>console.log(""))' 2>/dev/null | tr -d '\r'
}
monteur_token() { curl -s -m 10 -d grant_type=password -d client_id=werkorders-test -d username=m-017 -d password=welkom017 \
  http://localhost:8180/realms/werkorders/protocol/openid-connect/token | jget access_token; }

# Probeert als <gebruiker> te ontvangen of te versturen op eam.workorder.v1. Antwoord: ok | geweigerd
amqp_probe() { # amqp_probe <receive|send> <gebruiker> <wachtwoord>
  $DC exec -T -e MODUS="$1" -e U="$2" -e W="$3" source-adapter node -e '
    const rhea=require("rhea"); let klaar=false;
    const uit=(x)=>{ if(!klaar){klaar=true;console.log(x);process.exit(0);} };
    const c=rhea.connect({host:process.env.BROKER_HOST,port:Number(process.env.BROKER_PORT),username:process.env.U,password:process.env.W,reconnect:false});
    for (const e of ["connection_error","receiver_error","sender_error","receiver_close","sender_close","disconnected","error","rejected","released","modified"]) c.on(e,()=>uit("geweigerd"));
    if (process.env.MODUS==="receive") { c.open_receiver({source:{address:"eam.workorder.v1"},credit_window:0}); setTimeout(()=>uit("ok"),2500); }
    else { const s=c.open_sender("eam.workorder.v1"); s.on("sendable",x=>x.sender.send({durable:true,body:"{}"})); c.on("accepted",()=>uit("ok")); setTimeout(()=>uit("ok?"),4000); }
    setTimeout(()=>uit("geweigerd"),8000);' 2>/dev/null | tr -d '\r'
}

kafka_lees() { # kafka_lees <topic> -> schrijft naar $TMP/<topic>.txt (leest ongeveer 6 seconden)
  local f="$TMP/$1.txt"; : > "$f"
  $DC exec -T redpanda rpk topic consume "$1" -o start --format '%k|%v\n' > "$f" 2>/dev/null &
  local p=$!; sleep 6; kill "$p" 2>/dev/null; wait "$p" 2>/dev/null
}
heeft_event() { grep -q "^$2|.*\"eventType\":\"$3\"" "$TMP/$1.txt"; }

stuur() { # stuur <POST|GET> <pad> [json-body] -> body op stdout
  curl -s -m 15 -X "$1" -H 'Content-Type: application/json' ${3:+-d "$3"} "$BRON$2"
}

# ----------------------------------------------------------------------------------------------
kop "0. Is de omgeving er?"
for s in redpanda artemis werkorder-api source-adapter target-adapter; do
  if wacht_gezond "$s" 150; then groen "$s is healthy"; else rood "$s is niet healthy (docker compose logs $s)"; fi
done
controle "bron-app bereikbaar" bash -c "curl -sf -m 5 $BRON/health >/dev/null"
if [ "$FOUT" -gt 0 ]; then echo; echo "De omgeving draait niet goed; stop hier."; exit 1; fi

AANTAL0="$(queue_aantal eam.workorder.v1)"; DLQ0="$(queue_aantal eam.workorder.v1.dlq)"
if [ -z "$AANTAL0" ]; then info "Artemis-console (Jolokia) gaf geen antwoord; queue-controles worden overgeslagen"; fi
DLQ0="${DLQ0:-0}"

# ----------------------------------------------------------------------------------------------
kop "1. Nieuwe opdracht door de hele keten"
R="$(stuur POST /opdrachten '{"statusCode":"03"}')"
NR="$(echo "$R" | jget opdrachtNr)"; WO="$(wo_id "$NR")"
echo "      opdracht $NR -> werkorder $WO"
controle "bron-app: afgeleverd bij de source-adapter (HTTP 202)" [ "$(echo "$R" | jget uitkomst)/$(echo "$R" | jget http)" = "AFGELEVERD/202" ]
controle "werkorder-api: versie 1 opgeslagen (binnen 30 s)" wacht_versie "$WO" 1 30
kafka_lees werkorder-events
controle "Kafka werkorder-events: werkorder.aangemaakt voor $WO" heeft_event werkorder-events "$WO" werkorder.aangemaakt
kafka_lees werkorder-notificaties
controle "Kafka werkorder-notificaties: dun bericht voor $WO" grep -q "^$WO|.*\"monteurId\":\"M-" "$TMP/werkorder-notificaties.txt"
if [ -n "$AANTAL0" ]; then controle "Artemis: queue eam.workorder.v1 is leeg" wacht_tot 10 queue_is eam.workorder.v1 0; fi

# ----------------------------------------------------------------------------------------------
kop "2. Wijziging (status 04 = in uitvoering)"
R="$(stuur POST "/opdrachten/$NR/wijzigen" '{"statusCode":"04"}')"
controle "bron-app: afgeleverd" [ "$(echo "$R" | jget uitkomst)" = "AFGELEVERD" ]
controle "werkorder-api: versie 2 (binnen 30 s)" wacht_versie "$WO" 2 30
controle "werkorder-api: status IN_BEHANDELING" status_is "$WO" IN_BEHANDELING
kafka_lees werkorder-events
controle "Kafka werkorder-events: werkorder.gewijzigd" heeft_event werkorder-events "$WO" werkorder.gewijzigd

# ----------------------------------------------------------------------------------------------
kop "3. Intrekking"
R="$(stuur POST "/opdrachten/$NR/intrekken" '{"redenCode":"DUBBEL"}')"
controle "bron-app: afgeleverd" [ "$(echo "$R" | jget uitkomst)" = "AFGELEVERD" ]
controle "werkorder-api: versie 3 (ingetrokken)" wacht_versie "$WO" 3 30
if ingetrokken_is "$WO" 1 && status_is "$WO" AFGEROND; then groen "database: ingetrokken=1, status AFGEROND"; else rood "database: ingetrokken=1, status AFGEROND"; fi
kafka_lees werkorder-events
controle "Kafka werkorder-events: werkorder.ingetrokken" heeft_event werkorder-events "$WO" werkorder.ingetrokken

# ----------------------------------------------------------------------------------------------
kop "4. Ongeldig bericht wordt aan de rand afgewezen"
R="$(stuur POST '/opdrachten?fout=statusCode' '{}')"
controle "bron-app: afgekeurd met HTTP 422 en niet herhaald" [ "$(echo "$R" | jget uitkomst)/$(echo "$R" | jget http)" = "AFGEKEURD/422" ]
sleep 2
if [ -n "$AANTAL0" ]; then
  controle "Artemis: niets op de queue gekomen" queue_is eam.workorder.v1 0
  controle "Artemis: dead letter queue ongewijzigd ($DLQ0)" dlq_aantal_is "$DLQ0"
fi

# ----------------------------------------------------------------------------------------------
kop "4b. Permanent onverwerkbaar bericht op de queue: de target-adapter stuurt het naar de DLQ"
if [ -z "$AANTAL0" ]; then
  info "overgeslagen: zonder Artemis-console kan ik de DLQ niet tellen"
else
  T="$(date +%s)"
  echo 'dit is geen json' | zet_op_queue "dlq-test-geenjson-$T" && groen "bericht 1 (geen JSON) op de queue gezet" || rood "bericht 1 kon niet op de queue gezet worden"
  echo '{"envelope":{},"workOrder":{}}' | zet_op_queue "dlq-test-schema-$T" && groen "bericht 2 (geldige JSON, ongeldig canoniek model) op de queue gezet" || rood "bericht 2 kon niet op de queue gezet worden"
  controle "Artemis: beide berichten staan in eam.workorder.v1.dlq (binnen 20 s)" wacht_tot 20 dlq_is "$((DLQ0+2))"
  controle "Artemis: queue eam.workorder.v1 is weer leeg (origineel bevestigd)" wacht_tot 10 queue_is eam.workorder.v1 0
  controle "target-adapter logde reden GEEN_JSON" log_heeft "dlq-test-geenjson-$T.*GEEN_JSON"
  controle "target-adapter logde reden CANONIEK_ONGELDIG" log_heeft "dlq-test-schema-$T.*CANONIEK_ONGELDIG"
  controle "werkorder-api kreeg niets te zien van deze berichten" bash -c "! $DC logs werkorder-api 2>/dev/null | grep -q WO-9999"
  dlq_leegmaken; wacht_tot 10 dlq_is "$DLQ0" && info "testberichten uit de DLQ verwijderd" || info "DLQ niet opgeschoond; verwijder de testberichten zelf in de console (http://localhost:8161)"
fi

# ----------------------------------------------------------------------------------------------
kop "4c. Rechten: iedere partij kan alleen wat hij moet kunnen"
SRC_U="${SOURCE_ADAPTER_BROKER_USER:-source-adapter}"; SRC_W="${SOURCE_ADAPTER_BROKER_PASSWORD:-source-adapter-dev}"
TGT_U="${TARGET_ADAPTER_BROKER_USER:-target-adapter}"; TGT_W="${TARGET_ADAPTER_BROKER_PASSWORD:-target-adapter-dev}"
controle "Artemis: verkeerd wachtwoord wordt geweigerd" test "$(amqp_probe receive "$SRC_U" verkeerd)" = "geweigerd"
controle "Artemis: source-adapter mag NIET ontvangen van de queue" test "$(amqp_probe receive "$SRC_U" "$SRC_W")" = "geweigerd"
controle "Artemis: target-adapter mag NIET versturen naar de queue" test "$(amqp_probe send "$TGT_U" "$TGT_W")" = "geweigerd"
controle "Artemis: queue is na deze pogingen nog leeg" wacht_tot 5 queue_is eam.workorder.v1 0
SVC="$(service_token)"; MON="$(monteur_token)"
if [ -z "$SVC" ]; then rood "geen service-token van Keycloak gekregen (staat target-adapter in het realm? Keycloak opnieuw aanmaken: docker compose up -d --force-recreate keycloak)"; fi
[ -n "$SVC" ] && [ -n "$MON" ] || info "geen tokens: API-rechtencontroles worden overgeslagen"
if [ -n "$SVC" ] && [ -n "$MON" ]; then
  controle "werkorder-api: PUT /intern zonder token geeft 401" test "$(api_status PUT /intern/werkorders/WO-9998)" = "401"
  controle "werkorder-api: PUT /intern met monteurtoken geeft 401" test "$(api_status PUT /intern/werkorders/WO-9998 "$MON")" = "401"
  controle "werkorder-api: PUT /intern met service-token komt langs de autorisatie (422 op de lege body)" test "$(api_status PUT /intern/werkorders/WO-9998 "$SVC")" = "422"
  controle "werkorder-api: service-token mag de monteur-API niet lezen (401)" test "$(api_status GET /api/werkorders "$SVC")" = "401"
fi

# ----------------------------------------------------------------------------------------------
if [ "$VOLLEDIG" -eq 1 ]; then
  kop "5. Werkorder-API valt uit: bericht blijft veilig op de broker"
  $DC stop werkorder-api >/dev/null 2>&1
  R="$(stuur POST /opdrachten '{"statusCode":"03"}')"; NR5="$(echo "$R" | jget opdrachtNr)"; WO5="$(wo_id "$NR5")"
  controle "bron-app: afgeleverd (de broker heeft het bericht, ook al is de API weg)" [ "$(echo "$R" | jget uitkomst)" = "AFGELEVERD" ]
  sleep 5
  if [ -n "$AANTAL0" ]; then
    A="$(queue_aantal eam.workorder.v1)"
    controle "Artemis: bericht staat nog in de queue ($A)" test "${A:-0}" -ge 1
  fi
  $DC start werkorder-api >/dev/null 2>&1; wacht_gezond werkorder-api 90
  controle "na herstel: bericht alsnog verwerkt (herlevering, binnen 90 s)" wacht_versie "$WO5" 1 90
  if [ -n "$AANTAL0" ]; then controle "Artemis: queue weer leeg" wacht_tot 20 queue_is eam.workorder.v1 0; fi

  kop "6. Broker valt uit: de bron krijgt 503 en het systeem herstelt"
  $DC stop artemis >/dev/null 2>&1
  R="$(stuur POST /opdrachten '{"statusCode":"03"}')"
  controle "bron-app: eerste poging mislukt (OPNIEUW_PROBEREN, HTTP 503)" [ "$(echo "$R" | jget uitkomst)/$(echo "$R" | jget http)" = "OPNIEUW_PROBEREN/503" ]
  $DC start artemis >/dev/null 2>&1; wacht_gezond artemis 120
  wacht_gezond source-adapter 60; wacht_gezond target-adapter 60
  sleep 5
  R="$(stuur POST /opdrachten '{"statusCode":"03"}')"; NR6="$(echo "$R" | jget opdrachtNr)"; WO6="$(wo_id "$NR6")"
  controle "na herstel: nieuwe opdracht wordt afgeleverd" [ "$(echo "$R" | jget uitkomst)" = "AFGELEVERD" ]
  controle "na herstel: werkorder $WO6 in de API" wacht_versie "$WO6" 1 60

  kop "7. Hetzelfde bericht twee keer (ontdubbeling)"
  R="$(stuur POST /opdrachten '{"statusCode":"03"}')"; NR7="$(echo "$R" | jget opdrachtNr)"; WO7="$(wo_id "$NR7")"; MID="$(echo "$R" | jget berichtId)"
  wacht_versie "$WO7" 1 30
  stuur GET '/berichten?limit=1&bericht=1' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s)[0].bericht)))' > "$TMP/dubbel.json"
  $DC exec -T source-adapter node -e 'const b=require("fs").readFileSync(0,"utf8");fetch("http://localhost:8090/werkopdracht",{method:"POST",headers:{"Content-Type":"application/json"},body:b}).then(r=>console.log(r.status))' < "$TMP/dubbel.json" | grep -q 202 && groen "source-adapter nam het herhaalde bericht aan (202)" || rood "source-adapter weigerde het herhaalde bericht"
  sleep 4
  N="$($DC logs target-adapter 2>/dev/null | grep -c "\"messageId\":\"$MID\".*\"uitkomst\":\"bevestigd\"")"
  if [ "$N" = "1" ]; then groen "broker ontdubbelde op _AMQ_DUPL_ID: de target-adapter zag het bericht één keer"
  else info "target-adapter verwerkte het bericht $N keer: de broker ontdubbelt (nog) niet; de API ving het op via versie-idempotentie. Controleer dat de versie op 1 bleef:"; fi
  controle "werkorder-api: versie blijft 1" versie_is "$WO7" 1

  kop "8. Een bericht dat blijft mislukken gaat na de maximale pogingen naar de dead letter queue"
  if [ -n "$AANTAL0" ]; then
    DLQ8="$(queue_aantal eam.workorder.v1.dlq)"
    $DC stop werkorder-api >/dev/null 2>&1
    R="$(stuur POST /opdrachten '{"statusCode":"03"}')"; WO8="$(wo_id "$(echo "$R" | jget opdrachtNr)")"
    info "wachten tot Artemis het bericht opgeeft (5 pogingen met toenemende vertraging, tot 2 minuten)..."
    controle "bericht staat na uitputting van de pogingen in de DLQ" wacht_tot 150 dlq_is "$((DLQ8+1))"
    controle "queue eam.workorder.v1 is leeg" queue_is eam.workorder.v1 0
    $DC start werkorder-api >/dev/null 2>&1; wacht_gezond werkorder-api 90
    sleep 3
    controle "werkorder $WO8 is niet in de API gekomen (het wacht in de DLQ op een mens)" test -z "$(db_rij "$WO8")"
    dlq_leegmaken; wacht_tot 10 dlq_is "$DLQ8" && info "testbericht uit de DLQ verwijderd"
  else
    info "overgeslagen: zonder Artemis-console kan ik de DLQ niet tellen"
  fi
fi

# ----------------------------------------------------------------------------------------------
kop "Samenvatting"
printf '  %d groen, %d rood\n' "$OK" "$FOUT"
[ "$FOUT" -eq 0 ] && { echo "  Alles werkt."; exit 0; }
echo "  Kijk bij een rode regel eerst in:  docker compose logs <service> --tail 50"
exit 1

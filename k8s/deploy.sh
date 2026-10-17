#!/usr/bin/env bash
# Bouwt de images in Azure Container Registry en zet alles in het cluster.
#
# Gebruik (vanuit de projectmap):
#   ./k8s/deploy.sh <naam-van-je-acr>
#
# Vereist: az (ingelogd), kubectl (verbonden met je AKS-cluster) en een bestaand ACR dat aan het cluster gekoppeld is.
set -euo pipefail

ACR="${1:?Gebruik: ./k8s/deploy.sh <naam-van-je-acr>}"
TAG="$(date +%Y%m%d%H%M%S)"          # elke keer een nieuwe tag, zodat Kubernetes de pods echt vervangt
REGISTRY="${ACR}.azurecr.io"

cd "$(dirname "$0")/.."

# Korte vingerafdruk van een of meer bestanden. Staat als annotatie op de pod: verandert het bestand,
# dan verandert de annotatie en vervangt Kubernetes de pod vanzelf (ConfigMaps worden anders niet opnieuw gelezen).
vingerafdruk() { cat "$@" | shasum -a 256 | cut -c1-12; }
GATEWAY_HASH="$(vingerafdruk k8s/gateway/nginx.conf gateway/html/monteur-app.html)"
REALM_HASH="$(vingerafdruk keycloak/werkorders-realm.json)"

echo "==> 1/6 Images bouwen (lokaal, voor linux/amd64) en naar de registry pushen (tag ${TAG})"
az acr login --name "$ACR"
docker build --platform linux/amd64 -t "${REGISTRY}/ws-microservice:${TAG}" ./microservice
docker push "${REGISTRY}/ws-microservice:${TAG}"
docker build --platform linux/amd64 -t "${REGISTRY}/werkorder-api:${TAG}" ./werkorder-api
docker push "${REGISTRY}/werkorder-api:${TAG}"
# De adapters hebben de schema's uit contracts/ nodig: bouwcontext is de root van de repository
for naam in source-adapter target-adapter; do
  docker build --platform linux/amd64 -f "${naam}/Dockerfile" -t "${REGISTRY}/${naam}:${TAG}" .
  docker push "${REGISTRY}/${naam}:${TAG}"
done
docker build --platform linux/amd64 -t "${REGISTRY}/bron-app:${TAG}" ./bron-app
docker push "${REGISTRY}/bron-app:${TAG}"

echo "==> 2/6 Namespace, configuratie en geheimen"
kubectl apply -f k8s/00-namespace.yaml
kubectl -n werkorder create configmap gateway-nginx \
  --from-file=nginx.conf=k8s/gateway/nginx.conf --dry-run=client -o yaml | kubectl apply -f -
kubectl -n werkorder create configmap gateway-html \
  --from-file=monteur-app.html=gateway/html/monteur-app.html --dry-run=client -o yaml | kubectl apply -f -
kubectl -n werkorder create configmap keycloak-realm \
  --from-file=werkorders-realm.json=keycloak/werkorders-realm.json --dry-run=client -o yaml | kubectl apply -f -
# Beheerwachtwoord van Keycloak: eenmalig willekeurig aanmaken, nooit in git
if ! kubectl -n werkorder get secret keycloak-admin >/dev/null 2>&1; then
  kubectl -n werkorder create secret generic keycloak-admin --from-literal=password="$(openssl rand -hex 16)"
fi

kubectl -n werkorder create configmap artemis-etc-override \
  --from-file=broker.xml=artemis/etc-override/broker.xml --from-file=init-users.sh=artemis/init-users.sh \
  --dry-run=client -o yaml | kubectl apply -f -
# Artemis-inlog en de gedeelde sleutel van de interne API: eenmalig willekeurig aanmaken, nooit in git
if ! kubectl -n werkorder get secret artemis-credentials >/dev/null 2>&1; then
  kubectl -n werkorder create secret generic artemis-credentials --from-literal=user=artemis --from-literal=password="$(openssl rand -hex 16)"
fi
# Eigen Artemis-gebruikers per adapter (rollen eam-source en eam-target) en het geheim van het Keycloak-service-account
if ! kubectl -n werkorder get secret artemis-adapter-credentials >/dev/null 2>&1; then
  kubectl -n werkorder create secret generic artemis-adapter-credentials \
    --from-literal=source-user=source-adapter --from-literal=source-password="$(openssl rand -hex 16)" \
    --from-literal=target-user=target-adapter --from-literal=target-password="$(openssl rand -hex 16)"
fi
if ! kubectl -n werkorder get secret target-adapter-oidc >/dev/null 2>&1; then
  kubectl -n werkorder create secret generic target-adapter-oidc --from-literal=secret="$(openssl rand -hex 24)"
fi

echo "==> 3/6 Redpanda en Artemis"
kubectl apply -f k8s/10-redpanda.yaml
kubectl apply -f k8s/15-artemis.yaml
kubectl -n werkorder rollout status statefulset/redpanda --timeout=300s
kubectl -n werkorder rollout status statefulset/artemis --timeout=300s

echo "==> 4/6 Topics aanmaken"
kubectl -n werkorder delete job redpanda-topics --ignore-not-found
kubectl apply -f k8s/20-topics-job.yaml
kubectl -n werkorder wait --for=condition=complete job/redpanda-topics --timeout=180s

echo "==> 5/6 Keycloak (opstarten duurt een minuut of langer)"
sed -e "s#REALM_HASH#${REALM_HASH}#g" k8s/60-keycloak.yaml | kubectl apply -f -
kubectl -n werkorder rollout status deployment/keycloak --timeout=420s

echo "==> 6/6 Applicaties"
for bestand in k8s/30-ws-microservice.yaml k8s/40-werkorder-api.yaml k8s/42-source-adapter.yaml k8s/43-target-adapter.yaml k8s/44-bron-app.yaml k8s/50-gateway.yaml; do
  sed -e "s#REGISTRY#${REGISTRY}#g" -e "s#IMAGE_TAG#${TAG}#g" -e "s#GATEWAY_HASH#${GATEWAY_HASH}#g" "$bestand" | kubectl apply -f -
done
for d in ws-microservice werkorder-api source-adapter target-adapter bron-app api-gateway; do
  kubectl -n werkorder rollout status "deployment/${d}" --timeout=180s
done

echo
kubectl -n werkorder get pods
echo
echo "Klaar. Open twee terminals (of start het eerste met & op de achtergrond):"
echo "  kubectl -n werkorder port-forward svc/api-gateway 8080:80      # de app"
echo "  kubectl -n werkorder port-forward svc/keycloak 8180:8080       # inloggen"
echo "Een werkorder door de hele keten sturen (bron-app -> adapters -> Artemis -> API -> Kafka -> monteur):"
echo "  kubectl -n werkorder port-forward svc/bron-app 8095:8095 &  curl -X POST localhost:8095/opdrachten"
echo "Open daarna http://localhost:8080 en log in als m-017 (wachtwoord welkom017) of m-022 (welkom022)."

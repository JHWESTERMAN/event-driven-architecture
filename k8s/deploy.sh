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

echo "==> 1/6 Images bouwen in de cloud (tag ${TAG})"
az acr build --registry "$ACR" --image "ws-microservice:${TAG}" ./microservice
az acr build --registry "$ACR" --image "werkorder-api:${TAG}" ./werkorder-api

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

echo "==> 3/6 Redpanda"
kubectl apply -f k8s/10-redpanda.yaml
kubectl -n werkorder rollout status statefulset/redpanda --timeout=300s

echo "==> 4/6 Topics aanmaken"
kubectl -n werkorder delete job redpanda-topics --ignore-not-found
kubectl apply -f k8s/20-topics-job.yaml
kubectl -n werkorder wait --for=condition=complete job/redpanda-topics --timeout=180s

echo "==> 5/6 Keycloak (opstarten duurt een minuut of langer)"
sed -e "s#REALM_HASH#${REALM_HASH}#g" k8s/60-keycloak.yaml | kubectl apply -f -
kubectl -n werkorder rollout status deployment/keycloak --timeout=420s

echo "==> 6/6 Applicaties"
for bestand in k8s/30-ws-microservice.yaml k8s/40-werkorder-api.yaml k8s/50-gateway.yaml; do
  sed -e "s#REGISTRY#${REGISTRY}#g" -e "s#IMAGE_TAG#${TAG}#g" -e "s#GATEWAY_HASH#${GATEWAY_HASH}#g" "$bestand" | kubectl apply -f -
done
for d in ws-microservice werkorder-api api-gateway; do
  kubectl -n werkorder rollout status "deployment/${d}" --timeout=180s
done

echo
kubectl -n werkorder get pods
echo
echo "Klaar. Open twee terminals (of start het eerste met & op de achtergrond):"
echo "  kubectl -n werkorder port-forward svc/api-gateway 8080:80      # de app"
echo "  kubectl -n werkorder port-forward svc/keycloak 8180:8080       # inloggen"
echo "Open daarna http://localhost:8080 en log in als m-017 (wachtwoord welkom017) of m-022 (welkom022)."

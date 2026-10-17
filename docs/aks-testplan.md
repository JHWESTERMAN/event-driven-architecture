# Testplan: de keten op AKS

Doel: bewijzen dat de Kubernetes-manifesten, TLS en de geheimen ook buiten Docker Compose werken. Dit is het
equivalent van `scripts/smoketest.sh`, met de hand uitgevoerd. De manifesten zijn schema-gecontroleerd
(kubeconform, Kubernetes 1.30) maar nog niet op een cluster toegepast.

## 0. Voorwaarden

| Wat | Controle |
|---|---|
| Azure CLI, ingelogd | `az account show` |
| kubectl | `kubectl version --client` (Mac: `brew install azure-cli kubernetes-cli`) |
| Docker draait (deploy.sh bouwt lokaal voor linux/amd64) | `docker info` |
| Een AKS-cluster, kubectl verbonden | `az aks get-credentials -g <rg> -n <cluster>` en `kubectl get nodes` |
| Een ACR dat aan het cluster gekoppeld is | `az aks update -g <rg> -n <cluster> --attach-acr <acr>` |
| Genoeg ruimte | ruim 2 vCPU en 4 GiB vrij voor alle pods samen |

Gebruik bij voorkeur een wegwerpnamespace of testcluster. `deploy.sh` maakt de namespace `werkorder` aan.

## 1. Eerste test: geheimen als Kubernetes-Secret (zonder Key Vault)

```bash
./k8s/deploy.sh <naam-van-je-acr>
```

Verwacht: alle zes stappen lopen door en `kubectl -n werkorder get pods` toont alle pods `Running`
(`redpanda-topics` is een Job en eindigt met `Completed`).

## 2. Controles

Draai ze in deze volgorde en noteer per stap OK of FOUT.

```bash
NS="-n werkorder"

# 2.1 Alles gezond
kubectl $NS get pods                      # geen CrashLoopBackOff, geen Pending
kubectl $NS get pvc                       # artemis- en redpanda-schijf Bound

# 2.2 Artemis: initContainer heeft gewerkt, TLS staat aan
kubectl $NS logs statefulset/artemis -c configuratie     # eindigt zonder FOUT
kubectl $NS logs statefulset/artemis | grep -i -E "AMQ221007|AMQ221001|ssl|error" | head
kubectl $NS exec statefulset/artemis -- grep -c sslEnabled=true /var/lib/artemis-instance/etc/broker.xml   # 1

# 2.3 TLS vanuit het cluster: certificaat geldig voor "artemis", getekend door onze CA
kubectl $NS get secret artemis-tls -o jsonpath='{.data.ca\.pem}' | base64 -d > /tmp/aks-ca.pem
kubectl $NS port-forward svc/artemis 61616:61616 &  sleep 3
echo | openssl s_client -connect localhost:61616 -CAfile /tmp/aks-ca.pem -verify_hostname artemis 2>&1 | grep "Verify return code"   # 0 (ok)
kill %1

# 2.4 Adapters verbonden met de broker (TLS + login)
kubectl $NS logs deploy/source-adapter --tail 30     # verbonden met de broker, geen fout
kubectl $NS logs deploy/target-adapter --tail 30

# 2.5 Geheimen niet in de podspecificatie
kubectl $NS get deploy,statefulset -o yaml | grep -i -E "password|secret" | grep -v -E "secretKeyRef|secretName|name: |_FILE|key:" | head   # niets met een waarde

# 2.6 Keten: bron-app -> adapters -> Artemis -> API -> Kafka
kubectl $NS port-forward svc/bron-app 8095:8095 &  sleep 2
curl -s -X POST localhost:8095/opdrachten | head -c 300
kill %1
kubectl $NS logs deploy/target-adapter --tail 20      # bericht ontvangen en naar de API gestuurd
kubectl $NS logs deploy/werkorder-api --tail 20       # werkorder opgeslagen

# 2.7 Inloggen en monteursapp
kubectl $NS port-forward svc/api-gateway 8080:80 &
kubectl $NS port-forward svc/keycloak 8180:8080 &
# Browser: http://localhost:8080 , inloggen als m-017 / welkom017
```

## 3. Herstel testen

```bash
kubectl $NS delete pod -l app=artemis          # broker valt weg en komt terug
kubectl $NS get pods -w                        # artemis wordt Ready, adapters herstellen zonder handwerk
kubectl $NS rollout restart deploy/target-adapter
```

Verwacht: de adapters verbinden opnieuw en er gaat geen bericht verloren (journal staat op de PVC).

## 4. Tweede test: geheimen uit Azure Key Vault

Alleen als je het Key Vault-pad wilt valideren. Voorwaarden staan in de kop van `k8s/70-secrets-keyvault.yaml`.

```bash
./k8s/keyvault-vullen.sh <kluisnaam>
KEYVAULT_NAME=<kluis> KEYVAULT_TENANT_ID=<tenant> KEYVAULT_CLIENT_ID=<client-id> ./k8s/deploy.sh <acr>
kubectl -n werkorder get secret artemis-credentials artemis-adapter-credentials target-adapter-oidc keycloak-admin
```

Verwacht: de vier Secrets worden door de CSI-driver aangemaakt en daarna werkt stap 2 hetzelfde.

## 5. Opruimen

```bash
kubectl delete namespace werkorder
```

Dit verwijdert ook de PVC's. Verwijder de images uit de ACR als je ze niet meer nodig hebt.

## Waar je op moet letten

- **Artemis start niet / initContainer faalt**: lees de logs van `-c configuratie`. Artemis leest `etc-override` alleen bij het aanmaken van de instance; na een wijziging StatefulSet en PVC verwijderen.
- **Adapters: certificaatfout**: de CA in `artemis-tls` moet bij het servercertificaat horen. Heb je `artemis-tls` opnieuw gemaakt, herstart dan Artemis (nieuwe PVC) en de adapters.
- **Pods blijven `Pending`**: te weinig CPU of geheugen op de nodes, of de PVC kan niet gebonden worden (`kubectl describe pod`).
- **`ImagePullBackOff`**: de ACR is niet aan het cluster gekoppeld.
- **`StartError` met `read-only file system` bij `/var/run/secrets/kubernetes.io`**: een Secret is op `/run/secrets` gemonteerd. Kubernetes legt daar zelf het service-accounttoken neer. Monteer geheimen op een ander pad, zoals `/geheimen`.

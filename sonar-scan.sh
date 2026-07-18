#!/usr/bin/env bash
# Reusable SonarQube scan runner — copy into any repo alongside sonar-project.properties,
# then run `./sonar-scan.sh` from the repo root.
#
# Reads the shared instance's token from the central infra .env so individual repos
# never need to hold their own copy of the secret.
set -euo pipefail

INFRA_ENV="$HOME/Work/infra/sonarqube/.env"
if [ -f "$INFRA_ENV" ]; then
  # shellcheck disable=SC1090
  source "$INFRA_ENV"
fi

: "${SONAR_TOKEN:?SONAR_TOKEN not set — is the shared SonarQube stack running? See $INFRA_ENV}"

docker run --rm \
  -e SONAR_HOST_URL="http://host.docker.internal:9000" \
  -e SONAR_TOKEN="$SONAR_TOKEN" \
  -v "$(pwd):/usr/src" \
  sonarsource/sonar-scanner-cli

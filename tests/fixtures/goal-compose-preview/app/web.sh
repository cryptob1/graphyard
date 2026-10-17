# One HTTP request: / is the page, status.json the same facts as JSON.
read -r method path rest
while read -r line; do [ "$(printf '%s' "$line" | tr -d '\r')" = '' ] && break; done
heading=$(cat /app/heading.txt)
banner=$(cat /app/banner.txt)
state=$(cat /state/instance)
database=$(nc -w 2 db 5432 </dev/null)
# A production credential is any secret-shaped variable with a value, or a host credential path mounted in.
credentials=$(env | grep -v '^GRAPHYARD_PREVIEW_' | grep -E '^[A-Z_]*(TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|_KEY)[A-Z_]*=.' | cut -d= -f1 | sort | tr '\n' ' ')
for file in /var/run/docker.sock /root/.config /root/.ssh /root/.docker; do [ -e "$file" ] && credentials="$credentials$file "; done
credentials=${credentials:-none}
case "$path" in
  /status.json) type=application/json; body="{\"heading\":\"$heading\",\"state\":\"$state\",\"database\":\"$database\",\"credentials\":\"$credentials\"}" ;;
  *) type='text/html; charset=utf-8'; body="<!doctype html><title>$heading</title><h1>$heading</h1><p>$banner</p><p>$GRAPHYARD_PREVIEW_TITLE</p><p>state $state</p><p>database $database</p><p>production credentials $credentials</p><a href=\"status.json\">Status</a>" ;;
esac
printf 'HTTP/1.0 200 OK\r\nContent-Type: %s\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' "$type" "$(printf '%s' "$body" | wc -c)" "$body"

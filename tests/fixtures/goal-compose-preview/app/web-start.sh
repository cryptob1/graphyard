# The application: its state initialised once into its own volume, then one HTTP answer per connection.
[ -s /state/instance ] || printf '%s' "$APP_STATE" > /state/instance
exec nc -lk -p 8080 -e sh /app/web.sh

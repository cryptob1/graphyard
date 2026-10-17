# The database: initialised once into its own volume, then answering its name to every connection.
[ -s /data/name ] || printf '%s' "$DATABASE_NAME" > /data/name
exec nc -lk -p 5432 -e cat /data/name

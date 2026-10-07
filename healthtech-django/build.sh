#!/usr/bin/env bash
# Build de Render: instala dependencias, junta estáticos, migra la BD y (opcional) crea el admin.
set -o errexit

pip install --upgrade pip
pip install -r requirements.txt

python manage.py collectstatic --noinput
python manage.py migrate --noinput

# Crea el superusuario SOLO si defines DJANGO_SUPERUSER_USERNAME / _EMAIL / _PASSWORD en Render.
# Si ya existe, no pasa nada (el build continúa).
if [[ -n "${DJANGO_SUPERUSER_PASSWORD:-}" && -n "${DJANGO_SUPERUSER_USERNAME:-}" ]]; then
  python manage.py createsuperuser --noinput || echo "Superusuario ya existía: se omite."
fi

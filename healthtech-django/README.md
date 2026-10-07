# HealthTech TACO — API REST (Django REST Framework)

API para pacientes con **Terapia Anticoagulante Oral (TACO)**: gestión de medicamentos y horarios,
registro de tomas, historial de INR y lectura asistida (Gemini) de la hoja de dosificación.

- **Stack:** Python 3.12 · Django 6.1 · Django REST Framework · SimpleJWT · django-cors-headers · SQLite (local) / PostgreSQL (producción)
- **Frontend:** carpeta hermana `healthtech-frontend/` (HTML/CSS/JS puro)

## Modelos (interrelacionados)

```
User ──1:1── PerfilUsuario (rol: paciente | médico)
User ──1:N── Medicamento ──1:N── RegistroToma
User ──1:N── RegistroINR
```

## Ejecutar en local

```bash
cd healthtech-django
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env               # Windows: copy .env.example .env
# (opcional) completa GEMINI_API_KEY en .env para usar el escáner de recetas

python manage.py migrate
python manage.py createsuperuser   # para entrar a /admin y asignar roles
python manage.py runserver         # http://127.0.0.1:8000
python manage.py test              # 53 pruebas automáticas
```

Frontend (en otra terminal): `cd healthtech-frontend && python -m http.server 5500` → http://localhost:5500

**Asignar rol de médico:** en `/admin/` → *Perfiles de usuario* → cambiar `rol` a **Médico**.
Todo registro público nace como *paciente* (el rol no se puede enviar desde la API).

## Formato de respuesta (JSON estandarizado)

```jsonc
// Éxito
{ "ok": true, "status": 200, "data": { ... } }
// Listados paginados (?page=2&page_size=50)
{ "ok": true, "status": 200, "data": { "count": 3, "next": null, "previous": null, "results": [ ... ] } }
// Error
{ "ok": false, "status": 400, "error": { "code": "validation_error", "message": "...", "details": { "campo": ["..."] } } }
```

| Código | Cuándo ocurre |
|---|---|
| 200 | Lectura, actualización y eliminación correctas (el DELETE devuelve 200 con mensaje JSON) |
| 201 | Recurso creado |
| 400 | Datos inválidos / JSON malformado |
| 401 | Sin token, token inválido o vencido, credenciales incorrectas |
| 403 | Autenticado pero sin permiso (p. ej. un médico intentando modificar datos de un paciente) |
| 404 | El recurso no existe **o no te pertenece** |
| 429 | Rate limiting excedido |
| 500 | Error interno (nunca se filtran detalles) |
| 502 / 503 | Falla del servicio de IA / falta `GEMINI_API_KEY` |

## Endpoints (`/api/v1/`)

Todos exigen `Authorization: Bearer <access_token>` salvo los marcados como públicos.

| Método | Ruta | Descripción |
|---|---|---|
| POST | `auth/registro/` | Crea cuenta y devuelve `access` + `refresh` (público, 10/hora) |
| POST | `auth/login/` | Login con `email` + `password` (público, **5/min**) |
| POST | `auth/refresh/` | Renueva el access token (rota el refresh) |
| POST | `auth/logout/` | Invalida el refresh token (blacklist) |
| GET | `auth/perfil/` | Datos y rol del usuario autenticado |
| GET, POST | `medicamentos/` | Listar (con `?search=`, `?ordering=`, paginado) / crear |
| GET, PUT, PATCH, DELETE | `medicamentos/{id}/` | Detalle / reemplazar / editar / eliminar |
| POST | `medicamentos/{id}/confirmar/` | Confirma la toma de hoy y crea un `RegistroToma` |
| GET, POST | `registros-inr/` | Historial de INR / nueva lectura |
| GET, PUT, PATCH, DELETE | `registros-inr/{id}/` | Detalle / editar / eliminar |
| GET, POST | `tomas/` | Registros de toma (`?medicamento=<id>`) / crear |
| GET, PUT, PATCH, DELETE | `tomas/{id}/` | Detalle / editar / eliminar |
| GET | `pacientes/` · `pacientes/{id}/` | **Solo médicos** (403 para pacientes) |
| POST | `recetas/analizar/` | Sube `imagen` (multipart) y Gemini extrae INR y dosis (**10/hora**) |

Ejemplo:

```bash
curl -X POST http://127.0.0.1:8000/api/v1/auth/login/ \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@correo.cl","password":"Clave-Segura-2026!"}'

curl http://127.0.0.1:8000/api/v1/medicamentos/ -H "Authorization: Bearer <access>"
```

## Roles y permisos

| Rol | Alcance |
|---|---|
| Paciente | Solo ve y modifica **sus** datos (lo ajeno responde 404) |
| Médico | Lee los datos de todos los pacientes y accede a `pacientes/`; **no** puede modificarlos (403) |
| Admin (`is_staff`) | Acceso total |

## Medidas de seguridad implementadas

| Medida | Dónde |
|---|---|
| Autenticación JWT (SimpleJWT) con access 30 min, refresh rotativo y blacklist al cerrar sesión | `core/settings.py` (`SIMPLE_JWT`), `api/views.py` |
| `IsAuthenticated` por defecto en toda la API + permisos por dueño y rol | `REST_FRAMEWORK`, `api/permissions.py` |
| Rate limiting: login 5/min, registro 10/hora, IA 10/hora, anónimos y usuarios | `DEFAULT_THROTTLE_RATES`, `ScopedRateThrottle` en `api/views.py` |
| CORS restringido a los orígenes del frontend (variable `CORS_ALLOWED_ORIGINS`, nunca `ALLOW_ALL`) | `core/settings.py` |
| Secretos fuera del código (`.env`); la app **no arranca** en producción sin `DJANGO_SECRET_KEY` | `core/settings.py`, `.env.example` |
| Sanitización: rechazo de `<`, `>` y caracteres de control; validación estricta de dosis, rangos INR y fechas | `api/serializers.py` |
| Inyección SQL: solo ORM de Django (consultas parametrizadas), sin SQL manual | todo el proyecto |
| Anti *mass assignment*: `usuario`, `estadoAlerta`, `confirmadaHoy` y el rol son de solo lectura | `api/serializers.py` |
| Mismo mensaje para "usuario inexistente" y "clave incorrecta" (no se enumeran cuentas) | `LoginSerializer` |
| Validación de contraseñas de Django (largo, comunes, numéricas, similitud) | `AUTH_PASSWORD_VALIDATORS` |
| Subida de imágenes: tamaño máximo, formato real verificado con Pillow, re-codificación a JPEG | `api/ia.py`, `AnalizarRecetaView` |
| Errores 500 sin filtrar detalles internos + handlers JSON para 400/403/404/500 | `api/exceptions.py`, `api/error_handlers.py` |
| HTTPS, cookies seguras, HSTS y `X-Frame-Options` cuando `DJANGO_DEBUG=False` | `core/settings.py` |

## Despliegue (Render) y conexión con el frontend

El repositorio incluye `render.yaml` (en la raíz), `healthtech-django/build.sh` y `.python-version`.

### Opción A — Blueprint (la más rápida)
1. Sube el repositorio a GitHub (el `.env` y `db.sqlite3` **no** se suben: están en `.gitignore`).
2. Render → **New → Blueprint** → elige el repositorio. Crea la base PostgreSQL y el servicio web solos.
3. Cuando lo pida, pega `GEMINI_API_KEY` (y, si quieres entrar a `/admin`, `DJANGO_SUPERUSER_USERNAME/EMAIL/PASSWORD`).

### Opción B — Web Service manual
- **Root Directory:** `healthtech-django`
- **Build command:** `./build.sh`
- **Start command:** `gunicorn core.wsgi:application --bind 0.0.0.0:$PORT --workers 2 --timeout 120`

### Variables de entorno en Render

| Variable | Valor |
|---|---|
| `PYTHON_VERSION` | `3.12.3` |
| `DJANGO_SECRET_KEY` | clave larga y aleatoria (el blueprint la genera) |
| `DJANGO_DEBUG` | `False` |
| `DATABASE_URL` | cadena de PostgreSQL (el blueprint la conecta) |
| `CORS_ALLOWED_ORIGINS` | origen del frontend **sin "/" final ni ruta**, p. ej. `https://natt39.github.io` (varios, separados por coma) |
| `GEMINI_API_KEY` | tu clave de Google AI Studio |
| `DJANGO_ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS`, `NUM_PROXIES` | **No hace falta definirlas**: en Render el host propio se agrega solo y `NUM_PROXIES` vale 1 automáticamente |

> Sin `DATABASE_URL` la app usa SQLite, que en Render **se borra en cada despliegue**. Usa PostgreSQL.

### Conectar el frontend
1. En `healthtech-frontend/config.js` deja `API_BASE_URL` con la URL de tu servicio de Render (sin `/api/v1` ni "/" final).
2. Publica la carpeta `healthtech-frontend/` (GitHub Pages, Netlify, etc.) y agrega **ese origen** a `CORS_ALLOWED_ORIGINS`.
   - Para pruebas locales (`python -m http.server 5500`) los orígenes `http://localhost:5500` y `http://127.0.0.1:5500` ya vienen permitidos.
3. Comprueba: `https://TU-APP.onrender.com/api/v1/` debe responder JSON.

### Si algo falla
| Síntoma | Causa y solución |
|---|---|
| Error CORS en la consola del navegador | El origen del frontend no está en `CORS_ALLOWED_ORIGINS` (sin "/" final) → corrígelo y espera el redeploy |
| `400 Bad Request` al abrir la URL de la API | Host no permitido → revisa `DJANGO_ALLOWED_HOSTS` (en Render normalmente no hace falta) |
| La primera petición tarda ~1 minuto | El plan gratuito de Render "duerme" el servicio tras un rato inactivo; es normal, reintenta |
| `/admin` da 403 CSRF | Usa `https://` y define `CSRF_TRUSTED_ORIGINS` si usas un dominio propio |
| Los datos desaparecen | Falta `DATABASE_URL` (se está usando SQLite) |

**Asignar rol de médico en producción:** `https://TU-APP.onrender.com/admin/` → *Perfiles de usuario* → rol **Médico**.

> El rate limiting usa la caché en memoria de Django: con varios workers de gunicorn el conteo es por worker. Para producción real conviene Redis (`CACHES`).

## Estructura

```
core/            settings, urls, wsgi/asgi
build.sh · .python-version · ../render.yaml   despliegue en Render
api/models.py        PerfilUsuario, Medicamento, RegistroToma, RegistroINR
api/serializers.py   ModelSerializers + validaciones personalizadas
api/views.py         ViewSets, vistas de autenticación y de IA
api/permissions.py   roles y permiso por dueño
api/exceptions.py    formato de errores · api/renderers.py formato de éxito
api/ia.py            integración con Gemini
api/tests.py         53 pruebas
```

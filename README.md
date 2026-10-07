# HealthTech TACO

Sistema web para pacientes en **Terapia Anticoagulante Oral (TACO)**. Permite administrar medicamentos y horarios, registrar las tomas, llevar el historial de INR y leer con ayuda de IA (Gemini) la hoja de dosificación a partir de una foto.

Proyecto de la asignatura **Backend** (Evaluación Sumativa 03) · Analista Programador · INACAP Sede Punta Arenas.

## Enlaces

| Recurso | URL |
|---|---|
| Aplicación web (frontend) | https://creative-centaur-733159.netlify.app/ |
| API en producción (Render) | https://healthtech-3awy.onrender.com/api/v1/ |
| Repositorio | https://github.com/Natt39/HEALTHTECH |

> **Importante:** el backend está en el plan gratuito de Render, que duerme el servicio tras un rato sin uso. La **primera petición puede tardar hasta 1 minuto**. Si la página parece no responder, abre primero la URL de la API, espera a que muestre un JSON y luego recarga la aplicación.

## Tecnologías

- **Backend:** Python 3.12, Django 6.1, Django REST Framework, SimpleJWT, django-cors-headers, gunicorn, WhiteNoise
- **Base de datos:** SQLite en local y PostgreSQL en producción (Render)
- **IA:** Google Gemini (lectura de recetas)
- **Frontend:** HTML, CSS y JavaScript puro, publicado en Netlify
- **Despliegue de la API:** Render

## Estructura del repositorio

```
HEALTHTECH/
├── healthtech-django/      Backend (API REST)
│   ├── core/               settings, urls, wsgi
│   ├── api/                models, serializers, views, permissions, ia, tests
│   ├── requirements.txt
│   ├── .env.example        variables de entorno (sin claves reales)
│   ├── build.sh            comandos de build en Render
│   └── README.md           documentación detallada del backend
├── healthtech-frontend/    Frontend (index.html, app.js, config.js, style.css)
└── render.yaml             Blueprint de Render (opcional)
```

## Modelos

Cuatro modelos relacionados entre sí:

```
User ──1:1── PerfilUsuario (rol: paciente | médico)
User ──1:N── Medicamento ──1:N── RegistroToma
User ──1:N── RegistroINR
```

| Modelo | Campos principales |
|---|---|
| `PerfilUsuario` | usuario, rol |
| `Medicamento` | usuario, nombre, unidadPastilla, horaProgramada, horarioSemanal, periodicidad, proximoControl |
| `RegistroToma` | medicamento, fechaHora, estado, dosis, notas |
| `RegistroINR` | usuario, valorINR, rangoTerapeuticoMin, rangoTerapeuticoMax |

## Cómo ejecutar el proyecto en local

### Requisitos

- Python 3.12 o superior
- Git
- (Opcional) una clave de Google AI Studio para probar el escáner de recetas

### 1. Backend

```bash
git clone https://github.com/Natt39/HEALTHTECH.git
cd HEALTHTECH/healthtech-django

python -m venv .venv
# Windows:      .venv\Scripts\activate
# macOS/Linux:  source .venv/bin/activate

pip install -r requirements.txt

# Crear el archivo de variables de entorno
# Windows:      copy .env.example .env
# macOS/Linux:  cp .env.example .env

python manage.py migrate
python manage.py createsuperuser      # opcional: para entrar a /admin
python manage.py runserver
```

La API queda disponible en **http://127.0.0.1:8000/api/v1/**.

Para usar el escáner de recetas, completa `GEMINI_API_KEY` en el archivo `.env`. Sin esa clave el resto de la API funciona normalmente y solo el endpoint `recetas/analizar/` responde con error.

### 2. Frontend

1. Abre `healthtech-frontend/config.js` y deja la API local:
   ```js
   const API_BASE_URL = 'http://127.0.0.1:8000';
   ```
2. En otra terminal:
   ```bash
   cd HEALTHTECH/healthtech-frontend
   python -m http.server 5500
   ```
3. Abre **http://localhost:5500** en el navegador.

El origen `http://localhost:5500` ya está permitido por CORS en la configuración local. Para volver a usar la API de producción, deja en `config.js` la URL `https://healthtech-3awy.onrender.com`.

### 3. Pruebas automáticas

```bash
cd healthtech-django
python manage.py test
```

El proyecto incluye 53 pruebas (autenticación, permisos, validaciones, rate limiting, CORS, subida de imágenes y CRUD). Todas deben pasar.

### 4. Asignar el rol de médico

Todo usuario que se registra desde la API nace como **paciente**. Para crear un médico, entra a `/admin/` con el superusuario, abre *Perfiles de usuario* y cambia el rol a **Médico**.

## Variables de entorno

Se definen en `healthtech-django/.env` (modelo en `.env.example`). El archivo `.env` está en `.gitignore` y nunca se sube al repositorio.

| Variable | Descripción |
|---|---|
| `DJANGO_SECRET_KEY` | Clave secreta de Django. Obligatoria en producción |
| `DJANGO_DEBUG` | `True` en local, `False` en producción |
| `DJANGO_ALLOWED_HOSTS` | Hosts permitidos (en Render se agrega el propio automáticamente) |
| `CORS_ALLOWED_ORIGINS` | Orígenes del frontend, separados por coma y sin "/" final |
| `DATABASE_URL` | Cadena de PostgreSQL en producción. Si falta, se usa SQLite |
| `GEMINI_API_KEY` | Clave de Google AI Studio para leer recetas |
| `GEMINI_MODEL` | Modelo de Gemini a usar |

## Endpoints disponibles

Base: `/api/v1/`. Todos exigen el encabezado `Authorization: Bearer <access_token>`, salvo los marcados como públicos.

| Método | Ruta | Descripción | Acceso |
|---|---|---|---|
| GET | `/` | Lista de endpoints de la API | Público |
| POST | `auth/registro/` | Crea una cuenta y devuelve los tokens `access` y `refresh` | Público (10/hora) |
| POST | `auth/login/` | Inicia sesión con `email` y `password` | Público (5/min) |
| POST | `auth/refresh/` | Renueva el access token | Público (30/min) |
| POST | `auth/logout/` | Invalida el refresh token | Autenticado |
| GET | `auth/perfil/` | Datos y rol del usuario autenticado | Autenticado |
| GET, POST | `medicamentos/` | Listar (con `?search=` y `?ordering=`) o crear | Autenticado |
| GET, PUT, PATCH, DELETE | `medicamentos/{id}/` | Ver, reemplazar, editar o eliminar | Dueño |
| POST | `medicamentos/{id}/confirmar/` | Confirma la toma de hoy y crea un `RegistroToma` | Dueño |
| GET, POST | `registros-inr/` | Historial de INR o nueva lectura | Autenticado |
| GET, PUT, PATCH, DELETE | `registros-inr/{id}/` | Ver, editar o eliminar un registro | Dueño |
| GET, POST | `tomas/` | Listar tomas (con `?medicamento=<id>`) o registrar una | Autenticado |
| GET, PUT, PATCH, DELETE | `tomas/{id}/` | Ver, editar o eliminar una toma | Dueño |
| GET | `pacientes/` y `pacientes/{id}/` | Lista y detalle de pacientes | Solo médicos |
| POST | `recetas/analizar/` | Sube una imagen (`multipart`) y Gemini extrae INR y dosis | Autenticado (10/hora) |

**Dueño:** el paciente solo ve y modifica sus propios datos; lo que no le pertenece responde 404. Un médico puede leer los datos de los pacientes pero no modificarlos (403).

### Ejemplo de uso

```bash
# Iniciar sesión
curl -X POST http://127.0.0.1:8000/api/v1/auth/login/ \
  -H "Content-Type: application/json" \
  -d '{"email":"usuario@correo.cl","password":"Clave-Segura-2026!"}'

# Listar medicamentos con el token recibido
curl http://127.0.0.1:8000/api/v1/medicamentos/ \
  -H "Authorization: Bearer <access_token>"
```

## Formato de respuestas y códigos HTTP

Todas las respuestas son JSON con el mismo formato:

```jsonc
// Éxito
{ "ok": true, "status": 200, "data": { ... } }

// Error
{ "ok": false, "status": 400, "error": { "code": "validation_error", "message": "...", "details": { ... } } }
```

| Código | Cuándo ocurre |
|---|---|
| 200 | Lectura, actualización y eliminación correctas |
| 201 | Recurso creado |
| 400 | Datos inválidos o JSON mal formado |
| 401 | Sin token, token inválido o vencido, o credenciales incorrectas |
| 403 | Autenticado pero sin permiso (por ejemplo, un médico intentando modificar datos) |
| 404 | El recurso no existe o no pertenece al usuario |
| 429 | Se superó el límite de peticiones |
| 500 | Error interno (no se muestran detalles internos) |

## Seguridad implementada

- **Autenticación JWT** (SimpleJWT): access de 30 minutos, refresh de 7 días con rotación y lista negra; el logout invalida el refresh.
- **Autorización:** `IsAuthenticated` por defecto en toda la API y permisos propios por dueño y por rol (`IsOwnerOrMedicoReadOnly`, `IsMedico`).
- **Rate limiting** con `ScopedRateThrottle`: login 5/min, registro 10/hora, refresh 30/min e IA 10/hora.
- **Validación y sanitización** en los serializadores: se rechazan `<`, `>` y caracteres de control, y se validan dosis, rangos de INR y fechas.
- **Inyección SQL:** se usa solo el ORM de Django, sin SQL manual.
- **Subida de imágenes:** máximo 5 MB, solo JPEG, PNG o WEBP, con verificación del formato real y re-codificación.
- **CORS** restringido a los orígenes del frontend (nunca `ALLOW_ALL`).
- **Secretos** en variables de entorno; `.env` fuera del repositorio y `.env.example` sin claves reales.
- **Producción:** HTTPS forzado, HSTS, cookies seguras y `X-Frame-Options` en `DENY`.

## Despliegue

- **API:** Render, con PostgreSQL. Root Directory `healthtech-django`, Build Command `./build.sh` (instala dependencias, ejecuta `collectstatic` y `migrate`) y Start Command `gunicorn core.wsgi:application --bind 0.0.0.0:$PORT --workers 2 --timeout 120`.
- **Frontend:** Netlify. El archivo `healthtech-frontend/config.js` apunta a la URL de la API en Render, y el origen de Netlify está incluido en `CORS_ALLOWED_ORIGINS`.

La guía completa de despliegue y la solución de problemas comunes están en [`healthtech-django/README.md`](healthtech-django/README.md).

## Autoría

- Alexis Pino
- Martin López
- Maribel Gonzalez

Analista Programador · INACAP Sede Punta Arenas.

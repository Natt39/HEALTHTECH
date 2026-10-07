"""
Configuración de HealthTech TACO API (Django + Django REST Framework).

Toda la configuración sensible se lee desde variables de entorno (archivo .env
en local). Ver .env.example para la lista completa.
"""
import os
import sys
from datetime import timedelta
from pathlib import Path

import dj_database_url
from django.core.exceptions import ImproperlyConfigured
from django.core.management.utils import get_random_secret_key
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / '.env')


def env_bool(nombre, por_defecto=False):
    return os.environ.get(nombre, str(por_defecto)).strip().lower() in ('1', 'true', 'yes', 'on')


def env_list(nombre, por_defecto=''):
    return [x.strip() for x in os.environ.get(nombre, por_defecto).split(',') if x.strip()]


# --- Seguridad básica -------------------------------------------------------
DEBUG = env_bool('DJANGO_DEBUG', False)

SECRET_KEY = os.environ.get('DJANGO_SECRET_KEY', '')
if not SECRET_KEY:
    if DEBUG:
        # Solo desarrollo: clave efímera (los tokens dejan de valer al reiniciar).
        SECRET_KEY = get_random_secret_key()
    else:
        raise ImproperlyConfigured(
            'Falta DJANGO_SECRET_KEY. Copia .env.example a .env y define una clave larga y aleatoria.'
        )

ALLOWED_HOSTS = env_list('DJANGO_ALLOWED_HOSTS', '127.0.0.1,localhost')
CSRF_TRUSTED_ORIGINS = env_list('CSRF_TRUSTED_ORIGINS')

# Render define RENDER_EXTERNAL_HOSTNAME (p. ej. healthtech-3awy.onrender.com) y RENDER=true.
# Se agrega solo para que el servicio nunca responda 400 "DisallowedHost" y el /admin
# pueda iniciar sesión (CSRF) sin configurar nada a mano.
RENDER_HOST = os.environ.get('RENDER_EXTERNAL_HOSTNAME', '').strip()
EN_RENDER = env_bool('RENDER', False)
if RENDER_HOST:
    if RENDER_HOST not in ALLOWED_HOSTS:
        ALLOWED_HOSTS.append(RENDER_HOST)
    if f'https://{RENDER_HOST}' not in CSRF_TRUSTED_ORIGINS:
        CSRF_TRUSTED_ORIGINS.append(f'https://{RENDER_HOST}')

# --- Aplicaciones -----------------------------------------------------------
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    # Terceros
    'rest_framework',
    'rest_framework_simplejwt.token_blacklist',  # permite invalidar refresh tokens (logout)
    'corsheaders',
    # Propias
    'api',
]

MIDDLEWARE = [
    'django.middleware.security.SecurityMiddleware',
    'corsheaders.middleware.CorsMiddleware',  # antes de CommonMiddleware
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

if not DEBUG:
    # WhiteNoise sirve los estáticos del admin en producción (gunicorn)
    MIDDLEWARE.insert(1, 'whitenoise.middleware.WhiteNoiseMiddleware')

ROOT_URLCONF = 'core.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'core.wsgi.application'

# --- Base de datos ----------------------------------------------------------
# Por defecto SQLite. En producción (Render) define DATABASE_URL (PostgreSQL).
DATABASES = {
    'default': dj_database_url.config(
        default=f"sqlite:///{BASE_DIR / 'db.sqlite3'}",
        conn_max_age=600,
    )
}

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator',
     'OPTIONS': {'min_length': 8}},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

# Tests más rápidos: hash de contraseñas liviano (SOLO al ejecutar "manage.py test")
if 'test' in sys.argv:
    PASSWORD_HASHERS = ['django.contrib.auth.hashers.MD5PasswordHasher']

# --- Internacionalización ---------------------------------------------------
LANGUAGE_CODE = 'es-cl'
TIME_ZONE = 'America/Santiago'
USE_I18N = True
USE_TZ = True

# --- Archivos estáticos (panel /admin) --------------------------------------
STATIC_URL = 'static/'
STATIC_ROOT = BASE_DIR / 'staticfiles'
STORAGES = {
    'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
    'staticfiles': {'BACKEND': 'whitenoise.storage.CompressedStaticFilesStorage'},
}

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'

# --- CORS --------------------------------------------------------------------
# Orígenes del frontend (sin "/" final ni ruta). Se leen de CORS_ALLOWED_ORIGINS;
# si la variable no existe se usan los del proyecto: GitHub Pages + servidores locales.
# Nunca se usa CORS_ALLOW_ALL_ORIGINS.
CORS_ALLOWED_ORIGINS = [o.rstrip('/') for o in env_list(
    'CORS_ALLOWED_ORIGINS',
    'https://natt39.github.io,http://localhost:5500,http://127.0.0.1:5500,'
    'http://localhost:3000,http://127.0.0.1:3000',
)]
# La API usa JWT en la cabecera Authorization (no cookies): no hace falta CORS con credenciales.
CORS_ALLOW_CREDENTIALS = False
CORS_ALLOW_HEADERS = ['accept', 'authorization', 'content-type', 'origin', 'x-requested-with']
CORS_ALLOW_METHODS = ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT']
CORS_PREFLIGHT_MAX_AGE = 86400  # el navegador cachea el preflight 24 h (menos peticiones OPTIONS)

# --- Django REST Framework --------------------------------------------------
REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': (
        'rest_framework_simplejwt.authentication.JWTAuthentication',
    ),
    # Todo endpoint exige sesión salvo que declare AllowAny explícitamente.
    'DEFAULT_PERMISSION_CLASSES': (
        'rest_framework.permissions.IsAuthenticated',
    ),
    'DEFAULT_RENDERER_CLASSES': ('api.renderers.EnvelopeJSONRenderer',),
    'DEFAULT_PARSER_CLASSES': ('rest_framework.parsers.JSONParser',),
    'EXCEPTION_HANDLER': 'api.exceptions.custom_exception_handler',
    'DEFAULT_PAGINATION_CLASS': 'api.pagination.StandardPagination',
    'PAGE_SIZE': 20,
    'DEFAULT_FILTER_BACKENDS': (
        'rest_framework.filters.SearchFilter',
        'rest_framework.filters.OrderingFilter',
    ),
    # Rate limiting (anti fuerza bruta / abuso). Los "scopes" se asignan por vista.
    'DEFAULT_THROTTLE_CLASSES': (
        'rest_framework.throttling.AnonRateThrottle',
        'rest_framework.throttling.UserRateThrottle',
    ),
    'DEFAULT_THROTTLE_RATES': {
        'anon': os.environ.get('THROTTLE_ANON', '60/min'),
        'user': os.environ.get('THROTTLE_USER', '240/min'),
        'login': os.environ.get('THROTTLE_LOGIN', '5/min'),
        'registro': os.environ.get('THROTTLE_REGISTRO', '10/hour'),
        'refresh': os.environ.get('THROTTLE_REFRESH', '30/min'),
        'ia': os.environ.get('THROTTLE_IA', '10/hour'),
    },
    # Cuántos proxies hay delante (Render = 1). Con 0 se usa la IP directa y
    # no se puede falsear X-Forwarded-For para esquivar el rate limiting.
    # En Render se asume 1 automáticamente: con 0 todos los usuarios compartirían la IP
    # del proxy y el límite de login (5/min) se agotaría entre todos.
    'NUM_PROXIES': int(os.environ.get('NUM_PROXIES', '1' if EN_RENDER else '0')),
    'TEST_REQUEST_DEFAULT_FORMAT': 'json',
}

# --- JWT (SimpleJWT) --------------------------------------------------------
SIMPLE_JWT = {
    'ACCESS_TOKEN_LIFETIME': timedelta(minutes=int(os.environ.get('JWT_ACCESS_MINUTES', '30'))),
    'REFRESH_TOKEN_LIFETIME': timedelta(days=int(os.environ.get('JWT_REFRESH_DAYS', '7'))),
    'ROTATE_REFRESH_TOKENS': True,
    'BLACKLIST_AFTER_ROTATION': True,
    'AUTH_HEADER_TYPES': ('Bearer',),
    'SIGNING_KEY': SECRET_KEY,
}

# --- Límites para la subida de imágenes (análisis de recetas) ----------------
RECETA_MAX_BYTES = int(os.environ.get('RECETA_MAX_MB', '5')) * 1024 * 1024
DATA_UPLOAD_MAX_MEMORY_SIZE = RECETA_MAX_BYTES + 1024 * 1024

# --- IA (Gemini) ------------------------------------------------------------
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-3.5-flash')

# --- Endurecimiento para producción -----------------------------------------
X_FRAME_OPTIONS = 'DENY'
SECURE_CONTENT_TYPE_NOSNIFF = True
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')
    SECURE_SSL_REDIRECT = env_bool('DJANGO_SSL_REDIRECT', True)
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = int(os.environ.get('DJANGO_HSTS_SECONDS', '31536000'))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True

# --- Logging ----------------------------------------------------------------
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'formatters': {'simple': {'format': '[{levelname}] {name}: {message}', 'style': '{'}},
    'handlers': {'console': {'class': 'logging.StreamHandler', 'formatter': 'simple'}},
    'loggers': {'api': {'handlers': ['console'], 'level': 'INFO', 'propagate': False}},
}

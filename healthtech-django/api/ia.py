"""Análisis de hojas de dosificación TACO con Gemini (separado de las vistas para poder probarlo)."""
import base64
import io
import json
import logging

from django.conf import settings
from PIL import Image

logger = logging.getLogger(__name__)

DIAS = ('lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo')

ESQUEMA_RECETA = {
    'type': 'object',
    'properties': {
        'inr_actual': {'type': ['string', 'null']},
        'rango_terapeutico': {'type': ['string', 'null']},
        'medicamentos': {
            'type': 'array',
            'items': {
                'type': 'object',
                'properties': {
                    'nombre': {'type': 'string'},
                    'dosis_diaria': {
                        'type': 'object',
                        'properties': {dia: {'type': ['string', 'null']} for dia in DIAS},
                        'required': list(DIAS),
                    },
                },
                'required': ['nombre', 'dosis_diaria'],
            },
        },
    },
    'required': ['inr_actual', 'rango_terapeutico', 'medicamentos'],
}

INSTRUCCIONES_RECETA = '''
Lee solamente lo que se distingue en esta hoja de dosificación TACO.
Extrae literalmente el INR y el rango terapéutico; si no son legibles escribe null.
Extrae nombre del medicamento y gramaje solo si aparecen claramente.
Copia la dosis EXACTAMENTE como aparece para lunes a domingo,
incluyendo fracciones como 1+1/4 o 1+1/2. Si alguna dosis no se distingue, escribe null.
Usa las claves miercoles y sabado sin tildes.
No interpretes resultados ni indiques cambios en el tratamiento.
Devuelve únicamente el JSON solicitado.
'''


class IAConfigError(Exception):
    """Falta configuración del servicio de IA (clave API)."""


class IAResponseError(Exception):
    """La IA falló o devolvió un formato inesperado."""


def analizar_hoja_con_gemini(imagen_jpeg: bytes) -> dict:
    if not settings.GEMINI_API_KEY:
        raise IAConfigError('Falta configurar GEMINI_API_KEY en el servidor.')
    try:
        from google import genai  # import diferido: no es necesario para el resto de la API
        cliente = genai.Client(api_key=settings.GEMINI_API_KEY)
        interaccion = cliente.interactions.create(
            model=settings.GEMINI_MODEL,
            input=[
                {'type': 'text', 'text': INSTRUCCIONES_RECETA},
                {'type': 'image', 'data': base64.b64encode(imagen_jpeg).decode('utf-8'),
                 'mime_type': 'image/jpeg'},
            ],
            response_format={'type': 'text', 'mime_type': 'application/json', 'schema': ESQUEMA_RECETA},
            store=False,
        )
        datos = json.loads(interaccion.output_text or '')
    except (ValueError, json.JSONDecodeError) as exc:
        logger.exception('Gemini devolvió JSON inválido')
        raise IAResponseError('La IA no devolvió datos válidos. Prueba una foto más nítida.') from exc
    except Exception as exc:
        logger.exception('Fallo al consultar Gemini')
        raise IAResponseError('No se pudo analizar la receta en este momento.') from exc

    if not isinstance(datos, dict) or not isinstance(datos.get('medicamentos'), list):
        raise IAResponseError('La IA no devolvió datos válidos. Prueba una foto más nítida.')
    return datos


def normalizar_imagen(archivo) -> bytes:
    """Verifica que sea una imagen real, la re-codifica a JPEG y descarta metadatos."""
    imagen = Image.open(archivo)
    imagen.verify()
    archivo.seek(0)
    imagen = Image.open(archivo).convert('RGB')
    buffer = io.BytesIO()
    imagen.save(buffer, format='JPEG', quality=90)
    return buffer.getvalue()

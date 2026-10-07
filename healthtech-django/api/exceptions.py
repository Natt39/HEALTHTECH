import logging

from rest_framework import status
from rest_framework.exceptions import APIException, Throttled, ValidationError
from rest_framework.response import Response
from rest_framework.views import exception_handler

logger = logging.getLogger(__name__)

MENSAJES = {
    400: 'Los datos enviados no son válidos.',
    401: 'Autenticación requerida o token inválido/expirado.',
    403: 'No tienes permiso para realizar esta acción.',
    404: 'El recurso solicitado no existe.',
    405: 'Método HTTP no permitido para este recurso.',
    415: 'Tipo de contenido no soportado.',
    429: 'Demasiadas solicitudes. Intenta nuevamente más tarde.',
    500: 'Error interno del servidor.',
}


CODIGOS = {400: 'bad_request', 401: 'not_authenticated', 403: 'permission_denied', 404: 'not_found',
           405: 'method_not_allowed', 415: 'unsupported_media_type', 429: 'throttled'}


def cuerpo_error(codigo_http, codigo, mensaje, detalles=None):
    return {'ok': False, 'status': codigo_http,
            'error': {'code': codigo, 'message': mensaje, 'details': detalles}}


def custom_exception_handler(exc, context):
    """Convierte cualquier error (incluidos los no controlados) a JSON estandarizado."""
    response = exception_handler(exc, context)

    if response is None:  # excepción no prevista: nunca filtrar detalles internos
        vista = context.get('view').__class__.__name__ if context.get('view') else 'desconocida'
        logger.exception('Error no controlado en %s', vista, exc_info=exc)
        return Response(cuerpo_error(500, 'server_error', MENSAJES[500]),
                        status=status.HTTP_500_INTERNAL_SERVER_ERROR)

    codigo_http = response.status_code
    mensaje = MENSAJES.get(codigo_http, 'Error en la solicitud.')
    detalles = None
    codigo = CODIGOS.get(codigo_http, 'error')

    if isinstance(exc, ValidationError):
        codigo, detalles = 'validation_error', response.data
    elif isinstance(exc, Throttled):
        detalles = {'retry_after_seconds': exc.wait}
    elif isinstance(exc, APIException) and isinstance(exc.detail, str):
        # mensajes propios (p. ej. "Credenciales incorrectas") en español
        if getattr(exc, 'usar_detalle', False) or codigo_http in (400, 502, 503):
            mensaje = exc.detail
        if isinstance(exc.get_codes(), str):
            codigo = exc.get_codes()
    elif isinstance(exc, APIException):
        detalles = response.data  # p. ej. InvalidToken de SimpleJWT

    response.data = cuerpo_error(codigo_http, codigo, mensaje, detalles)
    return response


class CredencialesIncorrectas(APIException):
    """401 explícito (AuthenticationFailed se degrada a 403 cuando la vista no declara autenticación)."""
    status_code = 401
    default_detail = 'Credenciales incorrectas.'
    default_code = 'invalid_credentials'
    usar_detalle = True


class ServicioNoDisponible(APIException):
    status_code = 503
    default_detail = 'El servicio no está disponible en este momento.'
    default_code = 'service_unavailable'


class ErrorServicioExterno(APIException):
    status_code = 502
    default_detail = 'El servicio externo no respondió correctamente.'
    default_code = 'bad_gateway'

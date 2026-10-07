"""Handlers JSON para errores que ocurren fuera de DRF (rutas inexistentes, fallos graves)."""
from django.http import JsonResponse

from .exceptions import MENSAJES, cuerpo_error


def json_400(request, exception=None):
    return JsonResponse(cuerpo_error(400, 'bad_request', MENSAJES[400]), status=400)


def json_403(request, exception=None):
    return JsonResponse(cuerpo_error(403, 'permission_denied', MENSAJES[403]), status=403)


def json_404(request, exception=None):
    return JsonResponse(cuerpo_error(404, 'not_found', MENSAJES[404]), status=404)


def json_500(request):
    return JsonResponse(cuerpo_error(500, 'server_error', MENSAJES[500]), status=500)

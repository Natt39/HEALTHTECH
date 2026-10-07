from rest_framework.permissions import SAFE_METHODS, BasePermission

from .models import PerfilUsuario


def es_admin(user):
    return bool(user and user.is_authenticated and (user.is_staff or user.is_superuser))


def es_medico(user):
    if not (user and user.is_authenticated):
        return False
    perfil = getattr(user, 'perfil', None)
    return bool(perfil and perfil.rol == PerfilUsuario.Rol.MEDICO)


def rol_de(user):
    if es_admin(user):
        return 'admin'
    return 'medico' if es_medico(user) else 'paciente'


class IsMedico(BasePermission):
    """Solo médicos (o administradores)."""
    message = 'Se requiere rol de médico.'

    def has_permission(self, request, view):
        return es_admin(request.user) or es_medico(request.user)


class IsOwnerOrMedicoReadOnly(BasePermission):
    """
    - Dueño del recurso: acceso completo.
    - Médico: solo lectura sobre recursos de sus pacientes.
    - Administrador: acceso completo.
    - Cualquier otro caso: 403.
    """
    message = 'No tienes permiso para modificar este recurso.'

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated)

    def has_object_permission(self, request, view, obj):
        user = request.user
        if es_admin(user) or obj.propietario.pk == user.pk:
            return True
        return es_medico(user) and request.method in SAFE_METHODS

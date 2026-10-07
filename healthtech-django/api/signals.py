from django.contrib.auth.models import User
from django.db.models.signals import post_save
from django.dispatch import receiver

from .models import PerfilUsuario


@receiver(post_save, sender=User)
def crear_perfil(sender, instance, created, **kwargs):
    """Todo usuario nuevo (registro, admin o createsuperuser) recibe su perfil."""
    if created:
        PerfilUsuario.objects.get_or_create(usuario=instance)

from django.db import migrations


def crear_perfiles(apps, schema_editor):
    """Usuarios creados antes de existir PerfilUsuario reciben su perfil (rol paciente)."""
    User = apps.get_model('auth', 'User')
    PerfilUsuario = apps.get_model('api', 'PerfilUsuario')
    for user in User.objects.filter(perfil__isnull=True):
        PerfilUsuario.objects.create(usuario=user, rol='paciente')


class Migration(migrations.Migration):

    dependencies = [
        ('api', '0002_perfil_toma_y_ajustes'),
    ]

    operations = [
        migrations.RunPython(crear_perfiles, migrations.RunPython.noop),
    ]

from django.contrib import admin

from .models import Medicamento, PerfilUsuario, RegistroINR, RegistroToma


@admin.register(PerfilUsuario)
class PerfilUsuarioAdmin(admin.ModelAdmin):
    list_display = ('usuario', 'rol', 'creado')
    list_filter = ('rol',)
    search_fields = ('usuario__username', 'usuario__first_name')


@admin.register(Medicamento)
class MedicamentoAdmin(admin.ModelAdmin):
    list_display = ('nombre', 'usuario', 'horaProgramada', 'proximoControl')
    search_fields = ('nombre', 'usuario__username')


@admin.register(RegistroToma)
class RegistroTomaAdmin(admin.ModelAdmin):
    list_display = ('medicamento', 'estado', 'fechaHora')
    list_filter = ('estado',)


@admin.register(RegistroINR)
class RegistroINRAdmin(admin.ModelAdmin):
    list_display = ('usuario', 'valorINR', 'estadoAlerta', 'fechaLectura')

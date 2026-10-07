"""Rutas principales de HealthTech TACO."""
from django.contrib import admin
from django.urls import include, path

from api.views import home_view

urlpatterns = [
    path('admin/', admin.site.urls),
    path('', home_view, name='home'),
    path('api/v1/', include('api.urls')),
]

# Errores fuera de DRF también en JSON (se activan con DEBUG=False)
handler400 = 'api.error_handlers.json_400'
handler403 = 'api.error_handlers.json_403'
handler404 = 'api.error_handlers.json_404'
handler500 = 'api.error_handlers.json_500'

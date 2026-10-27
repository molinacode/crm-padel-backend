#!/usr/bin/env python3
"""Limpia un dump de Supabase para importarlo en el Postgres del VPS.

Quita lo que solo tiene sentido dentro de Supabase y que aquí falla:
RLS y sus políticas (ahora el portero es la API), las claves ajenas contra
auth.users, el DEFAULT auth.uid() y el SET transaction_timeout, que Postgres 16
no conoce (el dump lo genera pg_dump 17).

Uso: clean-supabase-dump.py entrada.sql salida.sql
"""
import re
import sys


def limpiar(lineas):
    salida = []
    quitadas = {
        'transaction_timeout': 0,
        'policies': 0,
        'rls': 0,
        'fk_auth': 0,
        'default_auth_uid': 0,
        'schema_public': 0,
    }
    i = 0
    while i < len(lineas):
        linea = lineas[i]

        if linea.startswith('SET transaction_timeout'):
            quitadas['transaction_timeout'] += 1
            i += 1
            continue

        if 'ROW LEVEL SECURITY' in linea:
            quitadas['rls'] += 1
            i += 1
            continue

        # El schema public ya existe en la base de destino.
        if linea.startswith('CREATE SCHEMA public;') or linea.startswith('COMMENT ON SCHEMA public'):
            quitadas['schema_public'] += 1
            i += 1
            continue

        # Bloques que pueden ocupar varias líneas hasta el punto y coma.
        if linea.startswith('CREATE POLICY') or linea.startswith('ALTER TABLE ONLY'):
            bloque = []
            while i < len(lineas):
                bloque.append(lineas[i])
                if lineas[i].rstrip().endswith(';'):
                    break
                i += 1
            i += 1
            texto = ''.join(bloque)
            if texto.startswith('CREATE POLICY'):
                quitadas['policies'] += 1
                continue
            if 'REFERENCES auth.' in texto:
                quitadas['fk_auth'] += 1
                continue
            salida.append(texto)
            continue

        if 'DEFAULT auth.uid()' in linea:
            quitadas['default_auth_uid'] += 1
            # La columna se queda sin valor por defecto y admitiendo nulos:
            # quien lo rellenaba era el auth de Supabase.
            linea = re.sub(r'\s*DEFAULT auth\.uid\(\)', '', linea)
            linea = re.sub(r'\s+NOT NULL(,?)$', r'\1', linea.rstrip('\n')) + '\n'

        salida.append(linea)
        i += 1

    return salida, quitadas


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1
    with open(sys.argv[1], encoding='utf-8') as f:
        lineas = f.readlines()
    salida, quitadas = limpiar(lineas)
    with open(sys.argv[2], 'w', encoding='utf-8') as f:
        f.writelines(salida)
    for clave, valor in quitadas.items():
        print(f'{clave}: {valor}')
    restos = [
        n + 1
        for n, l in enumerate(salida)
        if 'auth.' in l and not l.lstrip().startswith('--')
    ]
    print(f'lineas con auth. restantes: {len(restos)} {restos[:10]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

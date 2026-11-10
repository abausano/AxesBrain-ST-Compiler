(* Prova OOP del back-end .stc (METHOD, PROPERTY, EXTENDS, SUPER, chiamata virtuale). Modifica fatta da Claude. *)
FUNCTION_BLOCK Forma
  VAR Lato : LREAL := 1.0; END_VAR
  METHOD Area : LREAL
    Area := 0.0;
  END_METHOD
  METHOD Descrivi : LREAL
    VAR_OUTPUT Perimetro : LREAL; END_VAR
    Perimetro := THIS.Lato * 4.0;
    Descrivi := THIS.Area() + 0.5;
  END_METHOD
  PROPERTY Tipo : DINT
    GET
      Tipo := 0;
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK Quadrato EXTENDS Forma
  METHOD Area : LREAL
    Area := Lato * Lato;
  END_METHOD
  PROPERTY Tipo : DINT
    GET
      Tipo := 4;
    END_GET
  END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK Cerchio EXTENDS Forma
  METHOD Area : LREAL
    Area := 3.0 * Lato * Lato;
  END_METHOD
  METHOD Allarga
    VAR_INPUT Di : LREAL; END_VAR
    Lato := Lato + Di;
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION_BLOCK Misuratore
  VAR_IN_OUT F : Forma; END_VAR
  VAR_OUTPUT A : LREAL; P : LREAL; T : DINT; END_VAR
  A := F.Descrivi(Perimetro => P);
  T := F.Tipo;
END_FUNCTION_BLOCK

FUNCTION_BLOCK Contenitore
  VAR Q : Quadrato; END_VAR
  VAR_OUTPUT AreaQ : LREAL; END_VAR
  METHOD Imposta
    VAR_INPUT L : LREAL; END_VAR
    Q.Lato := L;
  END_METHOD
  AreaQ := Q.Area();
END_FUNCTION_BLOCK

PROGRAM Prova2
  VAR
    Q : Quadrato;
    C : Cerchio;
    M1 : Misuratore;
    M2 : Misuratore;
    K : Contenitore;
    Giri : DINT;
  END_VAR
  Giri := Giri + 1;
  IF Giri = 1 THEN
    Q.Lato := 2.0;
    K.Imposta(L := 5.0);
  END_IF
  C.Allarga(Di := 1.0);
  M1(F := Q);
  M2(F := C);
  K();
END_PROGRAM

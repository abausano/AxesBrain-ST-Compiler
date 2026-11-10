(* Prova OOP del back-end .stc (METHOD, PROPERTY, EXTENDS, SUPER, chiamata virtuale). Modifica fatta da Claude. *)
FUNCTION_BLOCK Contatore
  VAR_INPUT Passo : DINT := 1; END_VAR
  VAR_OUTPUT Valore : DINT; END_VAR
  VAR Chiamate : DINT; END_VAR

  METHOD Azzera
    Valore := 0;
  END_METHOD

  METHOD Somma : DINT
    VAR_INPUT A : DINT; B : DINT; END_VAR
    Somma := A + B + Nome();
  END_METHOD

  METHOD Nome : DINT
    Nome := 1;
  END_METHOD

  PROPERTY Doppio : DINT
    GET
      Doppio := Valore * 2;
    END_GET
    SET
      Valore := Doppio / 2;
    END_SET
  END_PROPERTY

  Valore := Valore + Passo;
  Chiamate := Chiamate + 1;
END_FUNCTION_BLOCK

FUNCTION_BLOCK ContatoreVeloce EXTENDS Contatore
  VAR Extra : DINT; END_VAR

  METHOD Nome : DINT
    Nome := 100;
  END_METHOD

  SUPER^();
  Extra := Extra + 1;
END_FUNCTION_BLOCK

PROGRAM Prova
  VAR
    C : Contatore;
    V : ContatoreVeloce;
    R1 : DINT;
    R2 : DINT;
    D : DINT;
    Giri : DINT;
  END_VAR
  Giri := Giri + 1;
  C(Passo := 2);
  V(Passo := 3);
  R1 := C.Somma(A := 10, B := 20);
  R2 := V.Somma(10, 20);
  D := V.Doppio;
  IF Giri = 5 THEN
    C.Azzera();
    V.Doppio := 1000;
  END_IF
END_PROGRAM

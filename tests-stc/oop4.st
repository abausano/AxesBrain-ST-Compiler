(* Prova OOP del back-end .stc (INTERFACE, METHOD con STRING/STRUCT, PROPERTY STRING; oop5: interfaccia vuota = trappola). Modifica fatta da Claude. *)
INTERFACE IMisura
  METHOD Valore : LREAL
  END_METHOD
  METHOD Nome : STRING
  END_METHOD
END_INTERFACE

TYPE Punto : STRUCT X : LREAL; Y : LREAL; END_STRUCT; END_TYPE

FUNCTION_BLOCK Sensore IMPLEMENTS IMisura
  VAR_INPUT Lettura : LREAL; END_VAR
  VAR Etichetta : STRING := 'sensore'; END_VAR
  METHOD Valore : LREAL
    Valore := Lettura;
  END_METHOD
  METHOD Nome : STRING
    Nome := CONCAT(Etichetta, '!');
  END_METHOD
  METHOD Posizione : Punto
    Posizione.X := Lettura;
    Posizione.Y := Lettura * 2.0;
  END_METHOD
  PROPERTY Testo : STRING
    GET
      Testo := Etichetta;
    END_GET
    SET
      Etichetta := Testo;
    END_SET
  END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK Costante IMPLEMENTS IMisura
  METHOD Valore : LREAL
    Valore := 42.0;
  END_METHOD
  METHOD Nome : STRING
    Nome := 'costante';
  END_METHOD
END_FUNCTION_BLOCK

FUNCTION Somma : LREAL
  VAR_INPUT M : IMisura; END_VAR
  Somma := M.Valore() + 1.0;
END_FUNCTION

PROGRAM Prova4
  VAR
    S : Sensore;
    K : Costante;
    A : ARRAY[1..3] OF Sensore;
    I : IMisura;
    R1 : LREAL; R2 : LREAL; R3 : LREAL; R4 : LREAL;
    N1 : STRING; N2 : STRING; T : STRING;
    P : Punto;
    Giri : DINT;
    k2 : INT;
  END_VAR
  Giri := Giri + 1;
  S(Lettura := 1.5);
  FOR k2 := 1 TO 3 DO
    A[k2](Lettura := INT_TO_LREAL(k2) * 10.0);
  END_FOR
  I := S;
  R1 := I.Valore();
  N1 := I.Nome();
  I := K;
  R2 := I.Valore();
  N2 := I.Nome();
  I := A[2];
  R3 := I.Valore();
  R4 := Somma(M := K) + Somma(M := A[3]);
  P := S.Posizione();
  IF Giri = 2 THEN S.Testo := 'nuovo'; END_IF
  T := S.Testo;
END_PROGRAM

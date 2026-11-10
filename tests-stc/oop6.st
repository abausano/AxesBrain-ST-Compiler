(* Prova OOP del back-end .stc: PROPERTY nelle INTERFACE, A[i].M(), A[i].P, a.b.M(). Modifica fatta da Claude. *)
INTERFACE IAsse
  METHOD Muovi
    VAR_INPUT Di : LREAL; END_VAR
  END_METHOD
  PROPERTY Quota : LREAL
    GET END_GET
    SET END_SET
  END_PROPERTY
  PROPERTY Nome : STRING
    GET END_GET
  END_PROPERTY
END_INTERFACE

FUNCTION_BLOCK Asse IMPLEMENTS IAsse
  VAR Q : LREAL; N : STRING := 'asse'; Mosse : DINT; END_VAR
  METHOD Muovi
    VAR_INPUT Di : LREAL; END_VAR
    Q := Q + Di;
    Mosse := Mosse + 1;
  END_METHOD
  METHOD Doppia : LREAL
    Doppia := Q * 2.0;
  END_METHOD
  PROPERTY Quota : LREAL
    GET Quota := Q; END_GET
    SET Q := Quota; END_SET
  END_PROPERTY
  PROPERTY Nome : STRING
    GET Nome := N; END_GET
  END_PROPERTY
END_FUNCTION_BLOCK

FUNCTION_BLOCK Macchina
  VAR Assi : ARRAY[1..3] OF Asse; END_VAR
  VAR_OUTPUT Somma : LREAL; END_VAR
  VAR k : INT; END_VAR
  Somma := 0.0;
  FOR k := 1 TO 3 DO
    Somma := Somma + Assi[k].Quota;
  END_FOR
END_FUNCTION_BLOCK

PROGRAM Prova6
  VAR
    A : ARRAY[1..3] OF Asse;
    M : Macchina;
    I : IAsse;
    k : INT;
    Giri : DINT;
    R1 : LREAL; R2 : LREAL; R3 : LREAL; R4 : LREAL; R5 : LREAL;
    N1 : STRING;
  END_VAR
  Giri := Giri + 1;
  IF Giri = 1 THEN
    FOR k := 1 TO 3 DO
      A[k].Quota := INT_TO_LREAL(k) * 100.0;
    END_FOR
    M.Assi[2].Quota := 7.0;
  END_IF
  A[2].Muovi(Di := 1.5);
  R1 := A[2].Quota;
  R2 := A[3].Doppia() + A[1].Doppia();
  I := A[1];
  I.Muovi(Di := 10.0);
  I.Quota := I.Quota + 0.25;
  R3 := I.Quota;
  N1 := I.Nome;
  M.Assi[3].Muovi(2.0);
  M();
  R4 := M.Somma;
  IF A[2].Doppia() > 210.0 THEN
    R5 := 1.0;
  END_IF
END_PROGRAM

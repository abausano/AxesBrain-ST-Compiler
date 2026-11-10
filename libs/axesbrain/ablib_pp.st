(* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
 *
 * Libreria AxesBrain: blocchi ST che lanciano part program .pp di AxesBrainSRV senza
 * bloccare la scansione (funzioni native AB_PP_* di SRV), e primi blocchi di movimento
 * con nomi e firme in stile PLCopen/CODESYS che chiamano .pp scritti da AB&T.
 *
 * Convenzione delle L (proposta 09/11/2026, 16 ingressi e 8 uscite dal 10/11/2026, Andrea):
 *   - ingresso: L1..L16 = parametri del blocco (L1 = numero dell'asse per i blocchi di movimento);
 *   - uscita:   L20 = codice d'errore restituito dal .pp (0 = tutto bene),
 *               L21..L28 = risultati (R1..R8 di AB_RunPP).
 * Se il .pp ha meno di 32 locali (NumeroLocali di sistema.txt), SRV le porta a 32 prima del lancio.
 * I .pp sono cercati nella cartella dei part program di AxesBrainSRV (PathPartProgramGP).
 * Un reset del sistema interrompe i .pp lanciati da qui: il blocco va in errore (-6).
 *)

FUNCTION AB_PP_NUOVO : DINT
  VAR_INPUT NOME : STRING(64); END_VAR
  {external native AB_PP_NUOVO}
END_FUNCTION

FUNCTION AB_PP_SETL : BOOL
  VAR_INPUT H : DINT; I : INT; V : LREAL; END_VAR
  {external native AB_PP_SETL}
END_FUNCTION

FUNCTION AB_PP_AVVIA : BOOL
  VAR_INPUT H : DINT; END_VAR
  {external native AB_PP_AVVIA}
END_FUNCTION

FUNCTION AB_PP_STATO : INT
  VAR_INPUT H : DINT; END_VAR
  {external native AB_PP_STATO}
END_FUNCTION

FUNCTION AB_PP_GETL : LREAL
  VAR_INPUT H : DINT; I : INT; END_VAR
  {external native AB_PP_GETL}
END_FUNCTION

FUNCTION AB_PP_RILASCIA : BOOL
  VAR_INPUT H : DINT; END_VAR
  {external native AB_PP_RILASCIA}
END_FUNCTION

(* Riferimento a un asse di AxesBrainSRV: Numero va in L1 dei .pp di movimento. *)
TYPE AXIS_REF :
  STRUCT
    Numero : INT;
    Nome : STRING(16);
  END_STRUCT
END_TYPE

(* Lancia un .pp e ne attende la fine nelle scansioni successive.
   Execute (fronte di salita) avvia; Busy durante l'esecuzione; alla fine Done oppure Error.
   ErrorID: codice L20 del .pp, oppure -1 tabella piena o nome non valido, -5 .pp non trovato,
   -6 .pp interrotto (reset, kill), -10 biglietto perso.
   Done ed Error restano finche' Execute e' alto e, se Execute e' gia' basso, per una scansione. *)
FUNCTION_BLOCK AB_RunPP
  VAR_INPUT
    Execute : BOOL;
    NomePP : STRING(64);
    L1, L2, L3, L4, L5, L6, L7, L8, L9, L10, L11, L12, L13, L14, L15, L16 : LREAL;
  END_VAR
  VAR_OUTPUT
    Done : BOOL;
    Busy : BOOL;
    Error : BOOL;
    ErrorID : DINT;
    R1, R2, R3, R4, R5, R6, R7, R8 : LREAL;
  END_VAR
  VAR
    H : DINT;
    Prec : BOOL;
    Visto : BOOL;
    Stato : INT;
    Ok : BOOL;
    I : INT;
    LIn : ARRAY[1..16] OF LREAL;
    ROut : ARRAY[1..8] OF LREAL;
  END_VAR

  IF NOT Execute AND (Done OR Error) AND Visto THEN
    Done := FALSE;
    Error := FALSE;
  END_IF

  IF Execute AND NOT Prec AND NOT Busy THEN
    Done := FALSE;
    Error := FALSE;
    ErrorID := 0;
    H := AB_PP_NUOVO(NomePP);
    IF H <= 0 THEN
      Error := TRUE;
      ErrorID := -1;
      H := 0;
    ELSE
      LIn[1] := L1;   LIn[2] := L2;   LIn[3] := L3;   LIn[4] := L4;
      LIn[5] := L5;   LIn[6] := L6;   LIn[7] := L7;   LIn[8] := L8;
      LIn[9] := L9;   LIn[10] := L10; LIn[11] := L11; LIn[12] := L12;
      LIn[13] := L13; LIn[14] := L14; LIn[15] := L15; LIn[16] := L16;
      FOR I := 1 TO 16 DO
        Ok := AB_PP_SETL(H, I, LIn[I]);
      END_FOR
      Ok := AB_PP_AVVIA(H);
      Busy := TRUE;
    END_IF
  END_IF
  Prec := Execute;

  IF Busy THEN
    Stato := AB_PP_STATO(H);
    CASE Stato OF
      4:  (* finito *)
        ErrorID := LREAL_TO_DINT(AB_PP_GETL(H, 20));
        FOR I := 1 TO 8 DO
          ROut[I] := AB_PP_GETL(H, 20 + I);
        END_FOR
        R1 := ROut[1];   R2 := ROut[2];   R3 := ROut[3];   R4 := ROut[4];
        R5 := ROut[5];   R6 := ROut[6];   R7 := ROut[7];   R8 := ROut[8];
        Error := ErrorID <> 0;
        Done := NOT Error;
        Busy := FALSE;
      5:
        Error := TRUE; ErrorID := -5; Busy := FALSE;
      6:
        Error := TRUE; ErrorID := -6; Busy := FALSE;
      0:
        Error := TRUE; ErrorID := -10; Busy := FALSE;
    END_CASE
    IF NOT Busy THEN
      Ok := AB_PP_RILASCIA(H);
      H := 0;
    END_IF
  END_IF
  Visto := Done OR Error;
END_FUNCTION_BLOCK

(* Abilitazione di un asse: MC_POWER.PP con L1 = asse, L2 = 1 (abilita) o 0 (disabilita). *)
FUNCTION_BLOCK MC_Power
  VAR_IN_OUT Axis : AXIS_REF; END_VAR
  VAR_INPUT Enable : BOOL; END_VAR
  VAR_OUTPUT Status : BOOL; Valid : BOOL; Error : BOOL; ErrorID : DINT; END_VAR
  VAR R : AB_RunPP; Ultimo : BOOL; Richiesta : BOOL; Obiettivo : BOOL; Primo : BOOL := TRUE; END_VAR
  IF (Enable <> Ultimo OR Primo) AND NOT R.Busy AND NOT Richiesta THEN
    Obiettivo := Enable;
    Ultimo := Enable;
    Richiesta := TRUE;
    Primo := FALSE;
  END_IF
  R(Execute := Richiesta, NomePP := 'MC_POWER.PP', L1 := INT_TO_LREAL(Axis.Numero), L2 := SEL(Obiettivo, 0.0, 1.0));
  IF R.Done THEN
    Status := Obiettivo;
    Error := FALSE;
    ErrorID := 0;
    Richiesta := FALSE;
  ELSIF R.Error THEN
    Error := TRUE;
    ErrorID := R.ErrorID;
    Richiesta := FALSE;
  END_IF
  Valid := NOT R.Busy AND NOT Error;
END_FUNCTION_BLOCK

(* Ricerca dello zero: MC_HOME.PP con L1 = asse, L2 = Position. *)
FUNCTION_BLOCK MC_Home
  VAR_IN_OUT Axis : AXIS_REF; END_VAR
  VAR_INPUT Execute : BOOL; Position : LREAL; END_VAR
  VAR_OUTPUT Done : BOOL; Busy : BOOL; Error : BOOL; ErrorID : DINT; END_VAR
  VAR R : AB_RunPP; END_VAR
  R(Execute := Execute, NomePP := 'MC_HOME.PP', L1 := INT_TO_LREAL(Axis.Numero), L2 := Position);
  Done := R.Done;
  Busy := R.Busy;
  Error := R.Error;
  ErrorID := R.ErrorID;
END_FUNCTION_BLOCK

(* Movimento assoluto: MC_MOVEABSOLUTE.PP con L1 = asse, L2 = Position, L3 = Velocity,
   L4 = Acceleration, L5 = Deceleration. *)
FUNCTION_BLOCK MC_MoveAbsolute
  VAR_IN_OUT Axis : AXIS_REF; END_VAR
  VAR_INPUT Execute : BOOL; Position : LREAL; Velocity : LREAL; Acceleration : LREAL; Deceleration : LREAL; END_VAR
  VAR_OUTPUT Done : BOOL; Busy : BOOL; Error : BOOL; ErrorID : DINT; END_VAR
  VAR R : AB_RunPP; END_VAR
  R(Execute := Execute, NomePP := 'MC_MOVEABSOLUTE.PP', L1 := INT_TO_LREAL(Axis.Numero), L2 := Position, L3 := Velocity, L4 := Acceleration, L5 := Deceleration);
  Done := R.Done;
  Busy := R.Busy;
  Error := R.Error;
  ErrorID := R.ErrorID;
END_FUNCTION_BLOCK

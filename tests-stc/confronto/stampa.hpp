// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2026 AB&T (Andrea Bausano). Modifica fatta da Claude.
//
// Printer for the comparison tests: formats STruC++ runtime values exactly like
// stvm-test --esatto (integers, REAL %.9g, LREAL %.17g, 'strings' with
// $hh escapes for spaces and control characters, [arrays]).
#pragma once

#include <cstdio>
#include <string>
#include <type_traits>

namespace confronto {

template <int N> struct Rank : Rank<N - 1> {};
template <> struct Rank<0> {};

inline void num(std::string& o, double v) {
    char b[64];
    snprintf(b, sizeof b, "%.17g", v);
    o += b;
}
inline void num(std::string& o, float v) {
    char b[64];
    snprintf(b, sizeof b, "%.9g", (double)v);
    o += b;
}
template <class T>
typename std::enable_if<std::is_integral<T>::value>::type num(std::string& o, T v) {
    if (std::is_signed<T>::value) o += std::to_string((long long)v);
    else o += std::to_string((unsigned long long)v);
}
template <class T>
typename std::enable_if<std::is_enum<T>::value>::type num(std::string& o, T v) {
    o += std::to_string((long long)v);
}

template <class T> void pr(std::string& o, const T& v);

// strings: anything with c_str()
template <class T>
auto pr_(std::string& o, const T& v, Rank<4>) -> decltype((void)v.c_str(), void()) {
    o += "'";
    for (const char* p = v.c_str(); *p; ++p) {
        unsigned char ch = (unsigned char)*p;
        if (ch <= 0x20 || ch >= 0x7f || ch == '$' || ch == '\'') {
            char b[4];
            snprintf(b, sizeof b, "$%02X", ch);
            o += b;
        } else {
            o += (char)ch;
        }
    }
    o += "'";
}
// arrays: anything iterable
template <class T>
auto pr_(std::string& o, const T& v, Rank<3>) -> decltype((void)v.begin(), (void)v.end(), void()) {
    o += "[";
    bool first = true;
    for (const auto& e : v) {
        if (!first) o += ",";
        first = false;
        pr(o, e);
    }
    o += "]";
}
// wrappers: IECVar<T>, IEC_ENUM_Var, IEC_ENUM_Value
template <class T>
auto pr_(std::string& o, const T& v, Rank<2>) -> decltype((void)v.get(), void()) {
    pr(o, v.get());
}
template <class T>
auto pr_(std::string& o, const T& v, Rank<1>) -> decltype(num(o, v), void()) {
    num(o, v);
}

template <class T> void pr(std::string& o, const T& v) { pr_(o, v, Rank<4>{}); }

template <class T> void campo(std::string& o, const char* name, const T& v) {
    o += " ";
    o += name;
    o += "=";
    pr(o, v);
}

}  // namespace confronto

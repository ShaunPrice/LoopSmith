#pragma once
#include <cstdint>
#include <cstdlib>
#include <cstring>
template<typename T> T constrain(T value, T low, T high) { return value < low ? low : (value > high ? high : value); }

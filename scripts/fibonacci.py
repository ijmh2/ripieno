#!/usr/bin/env python3
"""Print the first N Fibonacci numbers (default 30)."""

import sys


def fibonacci(n):
    a, b = 0, 1
    for _ in range(n):
        yield a
        a, b = b, a + b


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    for i, value in enumerate(fibonacci(n)):
        print(f"{i}: {value}")


if __name__ == "__main__":
    main()

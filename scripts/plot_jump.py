#!/usr/bin/env python3
"""
绘制Jump历史交易曲线图
"""
import sqlite3
import matplotlib
matplotlib.use('Agg')  # 非交互式后端
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from datetime import datetime
import os

# 设置中文字体
plt.rcParams['font.sans-serif'] = ['SimHei', 'DejaVu Sans', 'Arial Unicode MS', 'sans-serif']
plt.rcParams['axes.unicode_minus'] = False

# 数据库路径
DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'yanyu.db')

def get_jump_data():
    """从数据库获取Jump交易数据"""
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT date, client, counter_party, notional_t, trade_amt_ft, ft_net
        FROM trades 
        WHERE client = 'Jump'
        ORDER BY date ASC
    """)
    
    rows = cursor.fetchall()
    conn.close()
    
    # 按交易对手分组
    data = {'JUMPZL01': {'dates': [], 'notional': [], 'trade_amt': [], 'ft_net': []},
            'JUMPZL02': {'dates': [], 'notional': [], 'trade_amt': [], 'ft_net': []}}
    
    for row in rows:
        date_str, client, party, notional, trade_amt, ft_net = row
        date = datetime.strptime(str(date_str), '%Y%m%d')
        
        if party in data:
            data[party]['dates'].append(date)
            data[party]['notional'].append(notional / 1e8)  # 转换为亿
            data[party]['trade_amt'].append(trade_amt / 1e8)
            data[party]['ft_net'].append(ft_net / 1e8)
    
    return data

def plot_charts(data):
    """绘制曲线图"""
    fig, axes = plt.subplots(3, 1, figsize=(12, 10))
    fig.suptitle('Jump 历史交易曲线图', fontsize=14, fontweight='bold')
    
    colors = {'JUMPZL01': '#2E86AB', 'JUMPZL02': '#A23B72'}
    
    # 子图1: 存续名义本金
    ax1 = axes[0]
    for party, party_data in data.items():
        if party_data['dates']:
            ax1.plot(party_data['dates'], party_data['notional'], 
                    marker='o', markersize=4, label=party, color=colors[party], linewidth=1.5)
    ax1.set_ylabel('名义本金 (亿元)')
    ax1.set_title('存续名义本金')
    ax1.legend()
    ax1.grid(True, alpha=0.3)
    ax1.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'))
    
    # 子图2: 成交金额
    ax2 = axes[1]
    for party, party_data in data.items():
        if party_data['dates']:
            ax2.plot(party_data['dates'], party_data['trade_amt'], 
                    marker='s', markersize=4, label=party, color=colors[party], linewidth=1.5)
    ax2.set_ylabel('成交金额 (亿元)')
    ax2.set_title('成交金额')
    ax2.legend()
    ax2.grid(True, alpha=0.3)
    ax2.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'))
    
    # 子图3: 净头寸
    ax3 = axes[2]
    for party, party_data in data.items():
        if party_data['dates']:
            ax3.plot(party_data['dates'], party_data['ft_net'], 
                    marker='^', markersize=4, label=party, color=colors[party], linewidth=1.5)
            # 添加零线
            ax3.axhline(y=0, color='gray', linestyle='--', alpha=0.5)
    ax3.set_ylabel('净头寸 (亿元)')
    ax3.set_xlabel('日期')
    ax3.set_title('净头寸 (ft_net)')
    ax3.legend()
    ax3.grid(True, alpha=0.3)
    ax3.xaxis.set_major_formatter(mdates.DateFormatter('%m-%d'))
    
    plt.tight_layout()
    
    # 保存图片
    output_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'jump_history.png')
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f"图表已保存至: {output_path}")

if __name__ == '__main__':
    print("正在获取Jump交易数据...")
    data = get_jump_data()
    print(f"获取到 JUMPZL01: {len(data['JUMPZL01']['dates'])} 条记录")
    print(f"获取到 JUMPZL02: {len(data['JUMPZL02']['dates'])} 条记录")
    print("\n正在绘制曲线图...")
    plot_charts(data)
